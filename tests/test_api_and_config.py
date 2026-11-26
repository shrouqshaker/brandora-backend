"""HTTP layer, auth, error mapping, observability headers, dev endpoints, and AI_PROVIDER selection / fail-fast config."""
import pytest
from fastapi.testclient import TestClient
from google.genai import errors

import mock_data
from app.config import ConfigError, Settings, load_settings
from app.providers import build_providers
from app.providers.gemini import GeminiGenerator, GeminiRouter
from app.providers.rules import RulesRouter
from main import create_app
from tests.fake_gemini import FakeGemini, api_error, router_json
from tests.helpers import C1, VALIDATOR
from tests.test_catalog_policy import payload as railway_payload


def client(**kw) -> TestClient:
    # /v1 compatibility is intentionally explicit and local-only in tests.
    return TestClient(create_app(Settings(ai_provider="rules", app_env="local",
                                          legacy_api_enabled=True, **kw)),
                      raise_server_exceptions=False)


def fake_client(script, **kw):
    fake = FakeGemini(script, **kw)
    settings = fake.settings
    settings = settings.__class__(**{**settings.__dict__, "app_env": "local", "legacy_api_enabled": True})
    return TestClient(create_app(settings, build_providers(settings, client=fake)),
                      raise_server_exceptions=False), fake


# ---------------------------------------------------------------- /v1/ai/respond
def test_respond_returns_exactly_the_e03_body_and_observability_goes_in_headers():
    r = client().post("/v1/ai/respond", json=mock_data.build_request(C1, "عايز أطلب 2 تيشيرت أسود مقاس L"))
    assert r.status_code == 200
    body = r.json()
    VALIDATOR.validate(body)
    assert set(body) == {"intent", "reply", "requiresReview", "orderCandidate"}
    assert body["intent"] == "PURCHASE_INTENT" and body["orderCandidate"] is None
    assert r.headers["x-ai-source"] == "rules" and r.headers["x-ai-detailed-intent"] == "CREATE_ORDER"
    assert int(r.headers["x-ai-latency-ms"]) >= 0
    assert "\\u" not in r.text                      # Arabic goes out as real UTF-8


def test_real_railway_payload_end_to_end_over_http():
    r = client().post("/v1/ai/respond", json=railway_payload("بتفتحوا امتى؟"))
    assert r.status_code == 200 and r.json()["reply"].startswith("بنشتغل السبت من 10 الصبح")


@pytest.mark.parametrize("mutate,field", [
    (lambda p: p.update(message="   "), "message"),
    (lambda p: p.update(message="x" * 2001), "message"),
    (lambda p: p.pop("messageId"), "messageId"),
    (lambda p: p.update(messageId="nope"), "messageId"),
    (lambda p: p.pop("business"), "business"),
    (lambda p: p["customer"].update(id="nope"), "customer"),
    (lambda p: p["business"].update(workingHours={"MONDAY": "9-5"}), "workingHours"),   # a dict is not the rows list
])
def test_invalid_requests_get_400(mutate, field):
    p = mock_data.build_request(C1, "hi")
    mutate(p)
    r = client().post("/v1/ai/respond", json=p)
    assert r.status_code == 400 and r.json()["error"] == "VALIDATION_ERROR"
    assert any(field in d["field"] or field in d["message"] for d in r.json()["details"])


def test_the_old_mock_endpoints_are_gone_from_the_production_path():
    c = client()
    assert c.post("/detect-intent", json={}).status_code == 404
    assert c.post("/test-with-mock", json={}).status_code == 404
    assert c.post("/v1/dev/respond-with-mock", json={}).status_code == 404   # dev endpoints are off by default


def test_internal_token_protects_the_endpoint_but_not_health():
    c = client(ai_service_token="s3cret")
    p = mock_data.build_request(C1, "hi")
    assert c.post("/v1/ai/respond", json=p).status_code == 401
    assert c.post("/v1/ai/respond", json=p, headers={"X-Internal-Token": "wrong"}).status_code == 401
    assert c.post("/v1/ai/respond", json=p, headers={"X-Internal-Token": "s3cret"}).status_code == 200
    assert c.get("/health").status_code == 200 and c.get("/").json()["status"] == "ok"


def test_503_when_the_router_is_down_and_fallback_is_disabled():
    c, _ = fake_client({m: api_error(errors.ServerError, 503) for m in ("r-a", "r-b")}, fallback_to_rules=False)
    r = c.post("/v1/ai/respond", json=railway_payload("التيشيرت بكام؟"))
    assert r.status_code == 503 and r.headers["retry-after"] and r.json()["error"] == "AI_UNAVAILABLE"


def test_500_never_leaks_internals():
    c = client()
    c.app.state.orchestrator.respond = lambda *_: (_ for _ in ()).throw(RuntimeError("secret internals"))
    r = c.post("/v1/ai/respond", json=mock_data.build_request(C1, "hi"))
    assert r.status_code == 500 and r.json() == {"error": "INTERNAL_ERROR"}


def test_gemini_headers_show_the_models_and_a_guard_fallback():
    c, _ = fake_client({"r-a": router_json(["PRICE_INQUIRY"], product_query="T-Shirt"), "g-a": "T-Shirt بـ 1 جنيه."})
    r = c.post("/v1/ai/respond", json=railway_payload("التيشيرت بكام؟"))
    assert r.headers["x-ai-router-model"] == "r-a" and r.headers["x-ai-guard"] == "fallback-to-template"
    assert "x-ai-generator-model" not in r.headers and r.json()["reply"] == "T-Shirt بـ 299.99 جنيه."


def test_health_reports_models_without_calling_gemini_and_probe_is_opt_in():
    c, fake = fake_client({"r-a": router_json(["GREETING"]), "g-a": "ok", "r-b": "ok", "g-b": "ok"})
    body = c.get("/health").json()
    assert body["ai"]["provider"] == "gemini" and fake.calls == [] and "fake-key" not in str(body)
    probed = c.get("/health?probe=true").json()["ai"]["probe"]
    assert probed["router"]["ok"] and probed["generator"]["ok"] and fake.calls


# ---------------------------------------------------------------- dev playground (mock data), only when enabled
def test_dev_endpoints_work_only_when_enabled_and_respect_the_token():
    c = client(enable_dev_endpoints=True, ai_service_token="t")
    h = {"X-Internal-Token": "t"}
    assert c.get("/v1/dev/customers").status_code == 401
    assert len(c.get("/v1/dev/customers", headers=h).json()) == 10
    r = c.post("/v1/dev/respond-with-mock", headers=h, json={"customerWaId": C1, "message": "الاسود L اتنين", "includeRequest": True})
    body = r.json()
    assert r.status_code == 200 and "400 جنيه" in body["response"]["reply"] and "request" in body and "trace" in body
    assert c.post("/v1/dev/respond-with-mock", headers=h, json={"customerWaId": "201999999999", "message": "hi"}).status_code == 500 \
        or c.post("/v1/dev/respond-with-mock", headers=h, json={"customerWaId": "201999999999", "message": "hi"}).status_code == 404


# ---------------------------------------------------------------- AI_PROVIDER selection and fail-fast configuration
def test_gemini_provider_builds_router_and_generator_over_a_shared_client():
    s = Settings(ai_provider="gemini", gemini_api_key="k")
    p = build_providers(s)
    assert p.name == "gemini" and isinstance(p.router, GeminiRouter) and isinstance(p.generator, GeminiGenerator)
    assert isinstance(p.fallback_router, RulesRouter) and p.router.client is p.generator.client


def test_generator_can_be_left_out():
    assert build_providers(Settings(ai_provider="gemini", gemini_api_key="k", generator_enabled=False)).generator is None


def test_rules_provider_needs_no_key_and_has_no_generator():
    p = build_providers(Settings(ai_provider="rules"))
    assert p.name == "rules" and p.generator is None and isinstance(p.router, RulesRouter)


def test_gemini_without_a_key_refuses_to_start():
    with pytest.raises(ConfigError, match="GEMINI_API_KEY"):
        create_app(Settings(ai_provider="gemini", gemini_api_key=None))


def test_unknown_provider_refuses_to_start():
    with pytest.raises(ConfigError, match="AI_PROVIDER"):
        build_providers(Settings(ai_provider="openai"))


def test_main_app_does_not_expose_legacy_by_default():
    app = create_app(Settings(ai_provider="rules"))
    assert "/v1/ai/respond" not in app.openapi()["paths"]


def test_nonlocal_legacy_and_dev_are_rejected():
    with pytest.raises(ConfigError, match="legacy/dev"):
        create_app(Settings(ai_provider="rules", app_env="staging",
                            ai_service_token="x" * 32, legacy_api_enabled=True))
    with pytest.raises(ConfigError, match="legacy/dev"):
        create_app(Settings(ai_provider="rules", app_env="production",
                            ai_service_token="x" * 32, enable_dev_endpoints=True))


def test_dotenv_is_not_loaded_without_explicit_local_opt_in(monkeypatch, tmp_path):
    secret_file = tmp_path / ".private.env"
    secret_file.write_text("GEMINI_API_KEY=private-from-file\nROUTER_MODELS=private-model\n")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("ROUTER_MODELS", raising=False)
    monkeypatch.setenv("APP_ENV", "local")
    monkeypatch.setenv("DOTENV_PATH", str(secret_file))
    monkeypatch.delenv("LOAD_DOTENV", raising=False)
    assert load_settings().gemini_api_key is None
    assert load_settings().router_models[0].startswith("gemini-flash-lite")
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    monkeypatch.setenv("LOAD_DOTENV", "true")
    assert load_settings().gemini_api_key == "private-from-file"
    assert load_settings().router_models == ("private-model",)


def test_env_loading(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "Gemini")
    monkeypatch.setenv("GEMINI_API_KEY", " abc ")
    monkeypatch.setenv("ROUTER_MODELS", "m1, m2")
    monkeypatch.setenv("ENABLE_DEV_ENDPOINTS", "true")
    monkeypatch.setenv("GENERATOR_ENABLED", "false")
    s = load_settings()
    assert (s.ai_provider, s.gemini_api_key, s.router_models, s.enable_dev_endpoints, s.generator_enabled) == (
        "gemini", "abc", ("m1", "m2"), True, False)
    monkeypatch.delenv("ROUTER_MODELS")
    assert load_settings().router_models[0].startswith("gemini-flash-lite")
