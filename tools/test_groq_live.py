"""Live GroqCloud check using the SAME client the service uses (app.providers.groq).

    GROQ_API_KEY=... python tools/test_groq_live.py
    GROQ_API_KEY=... GROQ_MODELS="openai/gpt-oss-120b" python tools/test_groq_live.py

Proves: the key is valid, the model answers, strict JSON-schema output parses, and
how long a call takes. Prints no secret. Exit code 0 only if the model really answered.
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import BaseModel, ConfigDict  # noqa: E402

from app.config import load_settings  # noqa: E402
from app.providers.base import ProviderUnavailable  # noqa: E402
from app.providers.groq import GroqClient  # noqa: E402


class Ping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str
    language: str


async def main() -> int:
    settings = load_settings()
    if not settings.groq_api_key:
        print("FAIL: GROQ_API_KEY is not set")
        return 1
    client = GroqClient(settings)
    started = time.monotonic()
    try:
        result, model = await client.call(
            stage="ping", models=settings.groq_models,
            system="Reply ONLY with JSON matching the schema.",
            user='Answer in Egyptian Arabic: say hello to a customer of a clothing shop. Set language to "ar".',
            parse=lambda text: Ping.model_validate_json(text), schema=Ping, temperature=0.0)
    except ProviderUnavailable as error:
        print("FAIL: Groq unavailable. Diagnostics (category / http status):")
        for d in error.diagnostics:
            print(f"  - {d.category} (operation={d.operation}, http={d.http_status})")
        hints = {"authentication": "the API key is wrong or revoked", "permission_denied": "the key may not access this model",
                 "model_unavailable": "the model id in GROQ_MODELS does not exist for your account",
                 "rate_limit_or_quota": "rate limit / quota reached, retry later",
                 "timeout": "increase CHAT_PROVIDER_TIMEOUT_SECONDS (default 3) and CHAT_TOTAL_TIMEOUT_SECONDS (default 8)",
                 "api_schema_or_request_error": "this model rejects the JSON-schema request; try another GROQ_MODELS value"}
        for d in error.diagnostics:
            if d.category in hints:
                print(f"    hint: {hints[d.category]}")
        return 1
    print(f"OK: model={model} latency={time.monotonic() - started:.2f}s")
    print(f"    reply: {result.answer}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
