"""Offline tests of the explicitly attested Railway public-edge boundary.

The platform must replace forwarding headers, and every private-network peer
must be trusted. These tests do not claim headers authenticate a direct peer.
"""
import asyncio
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, load_settings
from app.offline_demo import OfflineHarness


DOMAIN = "brandora-ai-test.up.railway.app"
IDENTITIES = {
    "railway_project_id": "11111111-1111-4111-8111-111111111111",
    "railway_environment_id": "22222222-2222-4222-8222-222222222222",
    "railway_service_id": "33333333-3333-4333-8333-333333333333",
}


@pytest.fixture
def edge():
    return OfflineHarness(
        app_env="staging", railway_edge_https_enabled=True,
        railway_public_domain=DOMAIN, **IDENTITIES,
    )


def request(harness, *, headers=None, body=None, auth=None, tamper=False, claims=None):
    raw, signed = harness.encode(harness.body("black tshirt size L price"), **(claims or {}))
    forwarding = [
        ("host", DOMAIN), ("x-forwarded-host", DOMAIN),
        ("x-forwarded-proto", "https"),
    ] if headers is None else headers
    for name, value in (auth or {}).items():
        signed[name] = value
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=harness.app, client=("10.9.8.7", 1234)),
            base_url="http://" + DOMAIN,
        ) as client:
            return await client.post(
                "/v2/ai/respond", content=(raw if body is None else body) + (b" " if tamper else b""),
                headers=[*signed.items(), *forwarding],
            )
    return asyncio.run(run())


def test_opt_in_edge_preserves_signed_scoped_canonical_response(edge):
    response = request(edge)
    assert response.status_code == 200
    assert set(response.json()) == {"intent", "reply", "requiresReview", "orderCandidate"}
    assert response.json()["orderCandidate"] is None
    assert edge.calls
    assert all(call["businessId"] == edge.body("hi")["businessId"] for call in edge.calls)


def test_forwarded_headers_do_not_enable_railway_mode_implicitly():
    harness = OfflineHarness(app_env="staging")
    assert request(harness).status_code == 400
    assert not harness.calls and not harness.model_calls


@pytest.mark.parametrize("headers", [
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN)],
    [("host", DOMAIN), ("x-forwarded-proto", "https")],
    [("host", "other.up.railway.app"), ("x-forwarded-host", DOMAIN), ("x-forwarded-proto", "https")],
    [("host", DOMAIN), ("x-forwarded-host", "other.up.railway.app"), ("x-forwarded-proto", "https")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN), ("x-forwarded-proto", "http")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN), ("x-forwarded-proto", "https,http")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN), ("x-forwarded-proto", "https"), ("X-Forwarded-Proto", "https")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN), ("X-Forwarded-Host", DOMAIN), ("x-forwarded-proto", "https")],
    [("host", DOMAIN), ("Host", DOMAIN), ("x-forwarded-host", DOMAIN), ("x-forwarded-proto", "https")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN + ":443"), ("x-forwarded-proto", "https")],
    [("host", DOMAIN), ("x-forwarded-host", DOMAIN + ".evil.invalid"), ("x-forwarded-proto", "https")],
])
def test_missing_ambiguous_or_foreign_forwarding_headers_fail_closed(edge, headers):
    assert request(edge, headers=headers).status_code == 400
    assert not edge.calls and not edge.model_calls


@pytest.mark.parametrize("auth", [
    {"X-Internal-Token": "wrong"}, {"X-Internal-Token": ""},
    {"X-AI-Context": "invalid"}, {"X-AI-Context": ""},
])
def test_valid_edge_headers_never_replace_service_or_context_auth(edge, auth):
    assert request(edge, auth=auth).status_code == 401
    assert not edge.calls and not edge.model_calls


def test_edge_preserves_raw_body_hash_binding(edge):
    # Even equivalent JSON whitespace must retain the signed exact-byte binding.
    assert request(edge, tamper=True).status_code == 403
    assert not edge.calls and not edge.model_calls


@pytest.mark.parametrize("field", ["businessId", "customerId", "conversationId", "messageId"])
def test_edge_preserves_signed_tenant_and_conversation_bindings(edge, field):
    assert request(edge, claims={field: "99999999-9999-4999-8999-999999999999"}).status_code == 403
    assert not edge.calls and not edge.model_calls


def test_edge_preserves_body_limit_before_models(edge):
    assert request(edge, body=b"x" * 65537).status_code == 413
    assert not edge.calls and not edge.model_calls


@pytest.mark.parametrize("patch", [
    {"app_env": "local"}, {"trusted_proxy_cidrs": ("10.0.0.1/32",)},
    {"railway_public_domain": None}, {"railway_public_domain": ""},
    {"railway_public_domain": "https://" + DOMAIN},
    {"railway_public_domain": "*.up.railway.app"},
    {"railway_public_domain": DOMAIN + ":443"},
    {"railway_public_domain": DOMAIN + ".evil.invalid"},
    {"railway_public_domain": "localhost"},
    {"railway_project_id": None}, {"railway_environment_id": None},
    {"railway_service_id": None}, {"railway_service_id": "not-a-uuid"},
])
def test_explicit_railway_mode_requires_valid_deployment_configuration(edge, patch):
    with pytest.raises(ConfigError):
        replace(edge.settings, **patch).validate()


def test_configuration_loader_reads_only_explicit_railway_opt_in(monkeypatch):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("AI_PROVIDER", "rules")
    monkeypatch.setenv("RAILWAY_PUBLIC_DOMAIN", DOMAIN)
    for name, value in IDENTITIES.items():
        monkeypatch.setenv(name.upper(), value)
    monkeypatch.delenv("RAILWAY_EDGE_HTTPS_ENABLED", raising=False)
    assert load_settings().railway_edge_https_enabled is False
    monkeypatch.setenv("RAILWAY_EDGE_HTTPS_ENABLED", "true")
    settings = load_settings()
    assert settings.railway_edge_https_enabled is True
    assert settings.railway_public_domain == DOMAIN


def test_release_launcher_accepts_explicit_edge_mode_without_guessed_cidrs(monkeypatch, edge):
    from app import server
    monkeypatch.setattr(server, "load_settings", lambda: replace(edge.settings, groq_api_key=None))
    app = server.create_application()
    client = TestClient(app)
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.post("/v1/ai/respond", json={}).status_code == 404
    assert app.state.providers.name == "rules"
    assert not edge.calls and not edge.model_calls
