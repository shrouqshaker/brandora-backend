"""Gemini provider (google-genai): shared client with lazy init, per-stage model fallback chains, retries, cooldowns.

Policy (per model, in order):
  * 503 / 429 / 500 / 502 / 504  -> model overloaded: cooldown + move to the NEXT model immediately.
  * 404                          -> model id unknown for this key: disable it for this process, next model.
  * 401 / 403 / API-key errors   -> configuration problem: stop at once (other models cannot help).
  * 400 mentioning "schema"      -> retry once without response_schema (plain JSON mode).
  * timeout / network / bad JSON -> retry the SAME model after a delay, up to max_retries.
A per-stage deadline bounds the whole chain so the customer is never left waiting.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TypeVar

from pydantic import BaseModel

from ..config import Settings
from ..pipeline.context import Ctx
from ..prompts.generator import GENERATOR_SYSTEM_PROMPT, build_generator_prompt
from ..prompts.router import ROUTER_SYSTEM_PROMPT, build_router_prompt
from ..schemas import Intent, Plan, RouterResult
from .base import ProviderUnavailable
from .structured import StructuredOutputError, classify_failure, wire_json_schema

logger = logging.getLogger("brandora.gemini")
T = TypeVar("T")

OVERLOAD_CODES = {429, 500, 502, 503, 504}
FATAL_AUTH_CODES = {401, 403}


@dataclass
class ModelHealth:
    state: str = "unknown"  # unknown | ok | cooldown | disabled
    last_error: str | None = None
    last_ok_at: float | None = None
    cooldown_until: float = 0.0
    successes: int = 0
    failures: int = 0


def _error_code(exc: BaseException) -> int | None:
    code = getattr(exc, "code", None)
    return code if isinstance(code, int) else None


def _error_text(exc: BaseException) -> str:
    return re.sub(r"\s+", " ", str(exc))[:160]  # never include request headers / keys


class GeminiClient:
    def __init__(self, settings: Settings, sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.settings = settings
        self._sleep = sleep
        self._clock = clock
        self._client: Any = None
        self._use_schema = True
        self.health: dict[str, ModelHealth] = {}

    # ------------------------------------------------------------------ raw network call (the only place that touches the SDK)

    def _get_client(self) -> Any:
        if self._client is None:
            from google import genai  # lazy: the service boots instantly and the SDK is only touched on first use
            from google.genai import types

            self._client = genai.Client(
                api_key=self.settings.gemini_api_key,
                http_options=types.HttpOptions(timeout=int(self.settings.gemini_timeout_seconds * 1000)))
            logger.info("Gemini client initialised (lazy)")
        return self._client

    async def _generate(self, model: str, system: str, user: str, *, schema: type[BaseModel] | None,
                        temperature: float, mime: str) -> str | None:
        from google.genai import types

        kwargs: dict[str, Any] = {}
        if schema is not None and getattr(schema, "__gemini_json_schema__", False):
            kwargs["response_json_schema"] = wire_json_schema(schema)
        elif schema is not None and self._use_schema:
            kwargs["response_schema"] = schema
        config = types.GenerateContentConfig(system_instruction=system, temperature=temperature,
                                             response_mime_type=mime, **kwargs)
        response = await asyncio.wait_for(
            self._get_client().aio.models.generate_content(model=model, contents=user, config=config),
            timeout=self.settings.gemini_timeout_seconds)
        feedback = getattr(response, "prompt_feedback", None)
        if getattr(feedback, "block_reason", None):
            raise StructuredOutputError("output_blocked")
        for candidate in (getattr(response, "candidates", None) or [])[:1]:
            reason = getattr(candidate, "finish_reason", None)
            if reason in {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION"}:
                raise StructuredOutputError("output_blocked")
            if reason == "MAX_TOKENS":
                raise StructuredOutputError("output_truncated")
        return response.text

    # ------------------------------------------------------------------ retry / fallback policy

    async def call(self, *, stage: str, models: tuple[str, ...], system: str, user: str,
                   parse: Callable[[str | None], T], schema: type[BaseModel] | None = None,
                   temperature: float = 0.0, mime: str = "application/json") -> tuple[T, str]:
        deadline = self._clock() + self.settings.gemini_total_timeout_seconds
        last_reason = "no models available"
        diagnostics = []  # call-local; never a shared last-request field
        
        for idx, model in enumerate(models):
            health = self.health.setdefault(model, ModelHealth())
            if health.state == "disabled":
                continue
            if health.state == "cooldown" and self._clock() < health.cooldown_until:
                last_reason = f"{model} cooling down"
                continue
            attempt = 0
            while attempt < max(1, self.settings.gemini_max_retries):
                attempt += 1
                if self._clock() >= deadline:
                    raise ProviderUnavailable(f"{stage}: total timeout reached", diagnostics=diagnostics)
                logger.info("%s: trying model=%s attempt=%d", stage, model, attempt)
                operation = "sdk"
                try:
                    text = await self._generate(model, system, user, schema=schema, temperature=temperature, mime=mime)
                    operation = "parse"
                    value = parse(text)
                    if value is None:
                        raise StructuredOutputError("incompatible_output")
                except Exception as exc:  # noqa: BLE001 - every SDK/network error is classified below
                    diagnostic = classify_failure(exc, operation)
                    diagnostics.append(diagnostic)
                    logger.warning("%s: failure category=%s operation=%s http_status=%s attempt=%d",
                                   stage, diagnostic.category, operation, diagnostic.http_status, attempt)
                    if operation == "parse":
                        self._fail(model, diagnostic.category)
                        last_reason = f"{model}: {diagnostic.category}"
                        continue
                    code, msg = _error_code(exc), _error_text(exc)
                    if diagnostic.category in {"authentication", "permission_denied"}:
                        self._fail(model, f"auth error {code}")
                        raise ProviderUnavailable(f"authentication failed ({code}); check GEMINI_API_KEY", diagnostics=diagnostics) from None
                    if code == 404:
                        health.state, health.last_error = "disabled", "404 model not found"
                        logger.warning("%s: model=%s not found for this key; disabled", stage, model)
                        last_reason = f"{model}: not found"
                        break
                    if (code == 400 and "schema" in msg.lower() and self._use_schema and schema is not None
                            and not getattr(schema, "__gemini_json_schema__", False)):
                        logger.warning("schema rejected by model=%s; retrying in plain JSON mode", model)
                        self._use_schema = False
                        attempt -= 1
                        continue
                    if code in OVERLOAD_CODES:
                        health.state = "cooldown"
                        health.cooldown_until = self._clock() + self.settings.gemini_cooldown_seconds
                        self._fail(model, f"{code} overloaded", keep_state=True)
                        logger.warning("%s: model=%s returned %s; trying next model", stage, model, code)
                        last_reason = f"{model}: {code}"
                        break
                    self._fail(model, diagnostic.category)
                    last_reason = f"{model}: {diagnostic.category}"
                    if diagnostic.category in {"sdk_schema_error", "sdk_configuration_error", "output_blocked", "output_truncated"}:
                        raise ProviderUnavailable(last_reason, diagnostics=diagnostics) from None
                    if code is not None and 400 <= code < 500:
                        break  # deterministic request errors do not benefit from delayed retries
                    if attempt < self.settings.gemini_max_retries:
                        await self._sleep(self.settings.gemini_retry_delay_seconds)
                    continue
                else:
                    health.state, health.last_error, health.last_ok_at = "ok", None, time.time()
                    health.successes += 1
                    logger.info("%s: model=%s succeeded", stage, model)
                    return value, model
            
            # Log if we are moving to the next model in the chain
            if idx < len(models) - 1:
                logger.warning("%s: model=%s failed (%s). Falling back to next model...", stage, model, last_reason)
                
        raise ProviderUnavailable(f"{stage}: {last_reason}", diagnostics=diagnostics)

    def _fail(self, model: str, error: str, keep_state: bool = False) -> None:
        h = self.health.setdefault(model, ModelHealth())
        h.failures += 1
        h.last_error = error

    # ------------------------------------------------------------------ health

    def snapshot(self) -> list[dict[str, Any]]:
        now = self._clock()
        out = []
        names = list(dict.fromkeys(list(self.settings.router_models) + list(self.settings.generator_models)))
        for model in names:
            h = self.health.get(model, ModelHealth())
            state = "unknown" if (h.state == "cooldown" and now >= h.cooldown_until) else h.state
            out.append({"model": model, "role": ("router" if model in self.settings.router_models else "")
                        + ("+" if model in self.settings.router_models and model in self.settings.generator_models else "")
                        + ("generator" if model in self.settings.generator_models else ""),
                        "state": state, "lastError": h.last_error, "successes": h.successes, "failures": h.failures,
                        "cooldownSecondsLeft": max(0, round(h.cooldown_until - now)) if state == "cooldown" else 0})
        return out

    async def probe(self) -> dict[str, Any]:
        """Live check (one tiny request per role, costs almost nothing). GET /health?probe=true"""
        result: dict[str, Any] = {}
        for role, models in (("router", self.settings.router_models), ("generator", self.settings.generator_models)):
            try:
                _, model = await self.call(stage=f"probe-{role}", models=models, system="Reply with the word: ok",
                                           user="ping", parse=lambda text: text or "", temperature=0.0, mime="text/plain")
                result[role] = {"ok": True, "model": model}
            except ProviderUnavailable as exc:
                result[role] = {"ok": False, "reason": exc.reason}
        return result


# ----------------------------------------------------------------------------- Router


def parse_router(text: str | None) -> RouterResult:
    """Strict JSON in, validated RouterResult out. Anything off raises ValueError (-> retry)."""
    if not text or not text.strip():
        raise ValueError("empty router response")
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    result = RouterResult.model_validate_json(cleaned)
    if not result.intents:
        result.intents = [Intent.UNKNOWN]
    return result


class GeminiRouter:
    def __init__(self, client: GeminiClient, settings: Settings):
        self.client, self.settings = client, settings

    async def route(self, ctx: Ctx) -> tuple[RouterResult, str | None]:
        return await self.client.call(
            stage="router", models=self.settings.router_models, system=ROUTER_SYSTEM_PROMPT,
            user=build_router_prompt(ctx), parse=parse_router, schema=RouterResult,
            temperature=self.settings.router_temperature, mime="application/json")


# ----------------------------------------------------------------------------- Generator


def parse_text(text: str | None) -> str:
    if not text or not text.strip():
        raise ValueError("empty generator response")
    cleaned = re.sub(r"^```[a-z]*\s*|\s*```$", "", text.strip())
    cleaned = cleaned.strip().strip('"').strip("“”").strip()
    if not cleaned:
        raise ValueError("empty generator response")
    return cleaned


class GeminiGenerator:
    def __init__(self, client: GeminiClient, settings: Settings):
        self.client, self.settings = client, settings

    async def generate(self, ctx: Ctx, plan: Plan) -> tuple[str, str | None]:
        return await self.client.call(
            stage="generator", models=self.settings.generator_models, system=GENERATOR_SYSTEM_PROMPT,
            user=build_generator_prompt(ctx, plan), parse=parse_text,
            temperature=self.settings.generator_temperature, mime="text/plain")
