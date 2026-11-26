"""GroqCloud chat completions; no xAI/Grok, tools or arbitrary URLs."""
import asyncio
import json
import time

import httpx

from .base import ProviderUnavailable
from .structured import ProviderDiagnostic, wire_json_schema

# Keywords Groq's constrained decoding may reject. Pydantic and the grounding guard still
# enforce every one of these limits locally after the response comes back.
_GROQ_DROP = {"minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "format", "$id", "$anchor"}
# Fixed allowlist of Groq error codes/types that are safe to surface in diagnostics.
_SAFE_ERROR_HINTS = {"json_validate_failed", "invalid_request_error", "model_not_found", "model_decommissioned",
                     "context_length_exceeded", "rate_limit_exceeded", "tool_use_failed"}


def _groq_wire(schema):
    """Inline $ref/$defs and strip bounds so the schema is the plainest JSON Schema Groq accepts."""
    wire = wire_json_schema(schema)
    defs = wire.pop("$defs", {})
    def visit(node):
        if isinstance(node, list):
            return [visit(v) for v in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node and node["$ref"].startswith("#/$defs/"):
            return visit(defs[node["$ref"].split("/")[-1]])
        return {k: ({n: visit(v) for n, v in val.items()} if k == "properties" else visit(val))
                for k, val in node.items() if k not in _GROQ_DROP and k != "$defs"}
    return visit(wire)


def groq_schema(schema, *, strict=None):
    """Use strict decoding only when every object is closed and fully required.

    Meaning has dynamic business-defined option maps; Groq's strict mode cannot
    encode those. Use documented best-effort JSON Schema with identical strict
    application validation. Closed response-composition schemas use strict mode.
    """
    wire = _groq_wire(schema)
    def closed(node):
        if isinstance(node, list):
            return all(closed(v) for v in node)
        if not isinstance(node, dict):
            return True
        if node.get("type") == "object" and (
                node.get("additionalProperties") is not False
                or set(node.get("properties", {})) != set(node.get("required", []))):
            return False
        return all(closed(v) for v in node.values())
    return {"type": "json_schema", "json_schema": {
        "name": schema.__name__, "strict": closed(wire) if strict is None else strict, "schema": wire}}


class GroqClient:
    """One HTTP attempt per model; higher-level failover owns the total budget."""
    provider_name = "groq"
    endpoint = "https://api.groq.com/openai/v1/chat/completions"
    request_levels = 3  # strict schema -> non-strict schema -> JSON mode, advancing only on HTTP 400

    @property
    def api_key(self):
        return self.settings.groq_api_key

    @property
    def model_ids(self):
        return self.settings.groq_models

    def request_body(self, model, system, user, schema, temperature, level=0):
        """level 0 = strict schema; 1 = non-strict schema, no reasoning_effort; 2 = plain JSON mode.

        Levels 1-2 are used only after Groq answered HTTP 400 to the previous level.
        """
        if level >= 2:
            system = system + " Respond with one JSON object only, matching this JSON Schema: " + json.dumps(
                _groq_wire(schema), ensure_ascii=False, separators=(",", ":"))
            response_format = {"type": "json_object"}
        else:
            response_format = groq_schema(schema, strict=None if level == 0 else False)
        body = {"model": model,
                "messages": [{"role":"system","content":system},{"role":"user","content":user}],
                "temperature": temperature, "max_completion_tokens": 2048,
                "response_format": response_format}
        effort = getattr(self.settings, "groq_reasoning_effort", "")
        if level == 0 and "gpt-oss" in model and effort in {"low", "medium", "high"}:
            body["reasoning_effort"] = effort  # shorter hidden reasoning = much lower latency
        return body

    @staticmethod
    def _error_hint(response):
        try:
            error = response.json()["error"]
            for key in ("code", "type"):
                if isinstance(error.get(key), str) and error[key] in _SAFE_ERROR_HINTS:
                    return error[key]
        except (ValueError, KeyError, TypeError, AttributeError):
            pass
        return None

    def __init__(self, settings, *, transport=None, clock=time.monotonic):
        self.settings, self._transport, self._clock = settings, transport, clock
        self._cooldowns = {}  # model health only; no prompts or response payloads

    async def call(self, *, stage, models, system, user, parse, schema, temperature=0.0, mime="application/json"):
        if not self.api_key:
            raise ProviderUnavailable("Provider not configured", diagnostics=(ProviderDiagnostic("missing_key_configuration", "configuration"),))
        diagnostics = []
        deadline = self._clock() + self.settings.chat_total_timeout_seconds
        fatal = False
        for model in self.model_ids[:4]:
            if fatal or self._clock() >= deadline:
                if not fatal:
                    diagnostics.append(ProviderDiagnostic("timeout", "deadline"))
                break
            if self._cooldowns.get(model, 0) > self._clock():
                continue
            for level in range(self.request_levels):
                remaining = deadline - self._clock()
                if remaining <= 0:
                    diagnostics.append(ProviderDiagnostic("timeout", "deadline"))
                    break
                try:
                    async with httpx.AsyncClient(transport=self._transport, trust_env=False, follow_redirects=False,
                            timeout=self.settings.chat_provider_timeout_seconds) as client:
                        response = await asyncio.wait_for(client.post(self.endpoint,
                            headers={"Authorization": "Bearer " + self.api_key},
                            json=self.request_body(model,system,user,schema,temperature,level)),timeout=remaining)
                    code = response.status_code
                    if code != 200:
                        category = ("authentication" if code == 401 else "permission_denied" if code == 403 else
                                    "rate_limit_or_quota" if code == 429 else "model_unavailable" if code == 404 else
                                    "api_schema_or_request_error" if code == 400 else "api_unavailable")
                        diagnostics.append(ProviderDiagnostic(category, "sdk", code, schema_hint=self._error_hint(response)))
                        if code in {401, 403}:
                            fatal = True
                        elif code == 400 and level < self.request_levels - 1:
                            continue  # schema/params rejected: retry this model with a simpler request
                        break
                    payload = response.json()
                    choice = payload["choices"][0]
                    if choice.get("finish_reason") != "stop" or choice["message"].get("refusal"):
                        raise ValueError()
                    result = parse(choice["message"]["content"])
                    if result is None:
                        raise ValueError()
                    return result, model
                except (httpx.TimeoutException, asyncio.TimeoutError):
                    diagnostics.append(ProviderDiagnostic("timeout", "sdk"))
                except httpx.HTTPError:
                    diagnostics.append(ProviderDiagnostic("transport_error", "sdk"))
                except (ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
                    from .structured import StructuredOutputError
                    category = error.category if isinstance(error, StructuredOutputError) else "invalid_provider_output"
                    diagnostics.append(ProviderDiagnostic(category, "parse"))
                break
            if fatal:
                break
            self._cooldowns[model] = self._clock() + self.settings.chat_circuit_seconds
        raise ProviderUnavailable("Provider unavailable", diagnostics=diagnostics) from None
