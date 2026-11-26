"""Gemini retry / fallback / cooldown policy (the real GeminiClient code, scripted network)."""
import asyncio

import pytest
from google.genai import errors

from app.providers.base import ProviderUnavailable
from app.providers.gemini import GeminiClient, parse_router, parse_text
from app.schemas import Intent
from tests.fake_gemini import (GENERATOR_MODELS, ROUTER_MODELS, FakeGemini, api_error, gemini_settings, router_json,
                               timeout)


def call(fake: FakeGemini, models=ROUTER_MODELS, parse=parse_router, stage="router"):
    return asyncio.run(fake.call(stage=stage, models=models, system="s", user="u", parse=parse))


def test_success_on_the_first_model():
    f = FakeGemini({"r-a": router_json(["GREETING"])})
    rr, model = call(f)
    assert model == "r-a" and rr.intents == [Intent.GREETING] and f.sleeps == []


def test_503_moves_to_the_next_model_immediately_then_cools_down_then_recovers():
    f = FakeGemini({"r-a": api_error(errors.ServerError, 503, "overloaded", "UNAVAILABLE"), "r-b": router_json(["GREETING"])})
    _, model = call(f)
    assert model == "r-b" and f.models_called() == ["r-a", "r-b"] and f.sleeps == []
    assert {h["model"]: h["state"] for h in f.snapshot()}["r-a"] == "cooldown"
    call(f)
    assert f.models_called() == ["r-a", "r-b", "r-b"]      # r-a skipped while cooling down
    f.now += 61
    f.script["r-a"] = [router_json(["THANKYOU"])]
    assert call(f)[1] == "r-a"                              # cooldown over


def test_429_is_treated_like_overload():
    f = FakeGemini({"r-a": api_error(errors.ClientError, 429, "quota", "RESOURCE_EXHAUSTED"), "r-b": router_json(["GREETING"])})
    assert call(f)[1] == "r-b" and f.sleeps == []


def test_404_disables_the_model_for_the_process():
    f = FakeGemini({"r-a": api_error(errors.ClientError, 404, "not found", "NOT_FOUND"), "r-b": router_json(["GREETING"])})
    call(f); call(f)
    assert f.models_called().count("r-a") == 1
    assert {h["model"]: h["state"] for h in f.snapshot()}["r-a"] == "disabled"


@pytest.mark.parametrize("code", [401, 403])
def test_auth_errors_stop_everything(code):
    f = FakeGemini({"r-a": api_error(errors.ClientError, code, "denied", "PERMISSION_DENIED"), "r-b": router_json(["GREETING"])})
    with pytest.raises(ProviderUnavailable) as e:
        call(f)
    assert "authentication" in e.value.reason and f.models_called() == ["r-a"]


def test_bad_api_key_message_is_fatal_even_as_400():
    f = FakeGemini({"r-a": api_error(errors.ClientError, 400, "API key not valid", "INVALID_ARGUMENT"), "r-b": router_json(["GREETING"])})
    with pytest.raises(ProviderUnavailable):
        call(f)
    assert f.models_called() == ["r-a"]


def test_timeouts_retry_the_same_model_after_a_delay():
    f = FakeGemini({"r-a": [timeout(), timeout(), router_json(["GREETING"])]})
    _, model = call(f)
    assert model == "r-a" and f.models_called() == ["r-a"] * 3 and f.sleeps == [3.0, 3.0]


def test_bad_json_and_wrong_enum_are_retried_without_waiting():
    f = FakeGemini({"r-a": ["not json", '{"intents": ["MADE_UP"], "confidence": 0.9}', router_json(["GREETING"])]})
    rr, _ = call(f)
    assert rr.intents == [Intent.GREETING] and len(f.calls) == 3 and f.sleeps == []


def test_json_fences_and_extra_fields_are_tolerated():
    f = FakeGemini({"r-a": "```json\n" + router_json(["GREETING"], surprise="x") + "\n```"})
    assert call(f)[0].intents == [Intent.GREETING]


def test_schema_rejection_retries_in_plain_json_mode():
    f = FakeGemini({"r-a": [api_error(errors.ClientError, 400, "Invalid response_schema", "INVALID_ARGUMENT"), router_json(["GREETING"])]})
    asyncio.run(f.call(stage="router", models=("r-a",), system="s", user="u", parse=parse_router, schema=object))
    assert f._use_schema is False and f.models_called() == ["r-a", "r-a"]


def test_all_models_down():
    f = FakeGemini({m: api_error(errors.ServerError, 503) for m in ROUTER_MODELS})
    with pytest.raises(ProviderUnavailable):
        call(f)
    assert f.models_called() == list(ROUTER_MODELS)


def test_the_total_deadline_bounds_the_whole_chain():
    f = FakeGemini({"r-a": timeout()}, gemini_total_timeout_seconds=5.0)

    async def advancing(sec):
        f.now += 10

    f._sleep = advancing
    with pytest.raises(ProviderUnavailable) as e:
        call(f)
    assert "total timeout" in e.value.reason


def test_generator_text_parsing():
    assert parse_text('  "عندنا تيشيرت"  ') == "عندنا تيشيرت"
    assert parse_text("```\nhello\n```") == "hello"
    with pytest.raises(ValueError):
        parse_text("   ")


def test_health_snapshot_lists_both_roles_and_never_leaks_the_key():
    f = FakeGemini({"r-a": router_json(["GREETING"])})
    call(f)
    snap = f.snapshot()
    assert {h["model"] for h in snap} == set(ROUTER_MODELS + GENERATOR_MODELS)
    assert "fake-key" not in str(snap)
