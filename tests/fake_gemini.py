"""A scripted stand-in for the Gemini SDK: same retry/fallback code runs, only the network call is replaced."""
from __future__ import annotations

import asyncio
import json

from google.genai import errors

from app.config import Settings
from app.providers.gemini import GeminiClient

ROUTER_MODELS = ("r-a", "r-b")
GENERATOR_MODELS = ("g-a", "g-b")


def gemini_settings(**kw) -> Settings:
    base = dict(ai_provider="gemini", gemini_api_key="fake-key", app_env="local",
                legacy_api_enabled=True, router_models=ROUTER_MODELS,
                generator_models=GENERATOR_MODELS, gemini_retry_delay_seconds=3.0, gemini_cooldown_seconds=60.0,
                gemini_max_retries=3)
    base.update(kw)
    return Settings(**base)


def api_error(cls, code, msg="boom", status="X"):
    return cls(code, {"error": {"code": code, "message": msg, "status": status}})


def router_json(intents, **fields) -> str:
    return json.dumps({"intents": intents, "confidence": 0.95, **fields}, ensure_ascii=False)


class FakeGemini(GeminiClient):
    """`script` maps model -> outcomes. The last outcome repeats. str = reply text, Exception = raised."""

    def __init__(self, script: dict, **kw):
        self.sleeps: list[float] = []
        self.calls: list[tuple[str, str, str]] = []   # (model, system prompt, user prompt)
        self.now = 1000.0

        async def fake_sleep(sec):
            self.sleeps.append(sec)

        super().__init__(gemini_settings(**kw), sleep=fake_sleep, clock=lambda: self.now)
        self.script = {m: list(v) if isinstance(v, list) else [v] for m, v in script.items()}

    async def _generate(self, model, system, user, *, schema, temperature, mime):
        self.calls.append((model, system, user))
        outcomes = self.script[model]
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def models_called(self) -> list[str]:
        return [c[0] for c in self.calls]

    def prompts_for(self, models: tuple[str, ...]) -> list[str]:
        return [u for m, _, u in self.calls if m in models]


def timeout():
    return asyncio.TimeoutError()
