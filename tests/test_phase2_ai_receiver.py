"""Phase 2 AI receiver readiness tests; all Backend responses are synthetic."""
from __future__ import annotations

import asyncio
from dataclasses import replace

import httpx
from fastapi.testclient import TestClient

from app.http import create_app
from app.offline_demo import OfflineHarness


_EXPECTED = {"status": "ready", "database": "up", "contract": "conversation-tools-v1"}


def _app(handler, **patch):
    harness = OfflineHarness(**patch)
    settings = harness.settings
    return create_app(settings, products_transport=httpx.MockTransport(handler)), harness


def test_ready_success_is_authenticated_backend_probe_without_context_header():
    seen = {}

    async def handler(request):
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("Authorization")
        seen["context"] = request.headers.get("X-AI-Context")
        return httpx.Response(200, json=_EXPECTED)

    app, harness = _app(handler)
    response = TestClient(app).get("/ready")
    assert response.status_code == 200
    assert response.json() == {
        **_EXPECTED,
        "backendLiveVerified": True,
        "providerLiveVerified": False,
        "ordersEnabled": False,
    }
    assert seen == {
        "method": "GET",
        "url": "https://synthetic.invalid/internal/ai/health",
        "authorization": "Bearer " + harness.settings.backend_service_token,
        "context": None,
    }


def test_ready_backend_auth_failure_is_not_hidden_by_marker(tmp_path):
    marker = tmp_path / "ready"
    marker.write_text("ready\n", encoding="ascii")

    async def handler(request):
        return httpx.Response(401, json={"status": "ready"})

    app, _ = _app(handler, dependency_readiness_file=str(marker))
    response = TestClient(app).get("/ready")
    assert response.status_code == 503
    assert response.json() == {
        "status": "backend_unavailable",
        "backendLiveVerified": False,
        "providerLiveVerified": False,
        "ordersEnabled": False,
    }


def test_ready_probe_has_a_total_deadline():
    async def handler(request):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=_EXPECTED)

    app, _ = _app(handler, backend_timeout_seconds=0.005)
    response = TestClient(app).get("/ready")
    assert response.status_code == 503
    assert response.json()["backendLiveVerified"] is False


def test_ready_probe_rejects_oversized_response_before_json_parse():
    async def handler(request):
        body = b"{" + b"x" * 100 + b"}"
        return httpx.Response(200, content=body, headers={"Content-Length": str(len(body))})

    app, _ = _app(handler, backend_max_response_bytes=16)
    response = TestClient(app).get("/ready")
    assert response.status_code == 503
    assert response.json()["backendLiveVerified"] is False


def test_ready_probe_requires_exact_health_contract():
    async def handler(request):
        return httpx.Response(200, json={**_EXPECTED, "extra": "not allowed"})

    app, _ = _app(handler)
    response = TestClient(app).get("/ready")
    assert response.status_code == 503
    assert response.json()["backendLiveVerified"] is False


def test_ready_probe_does_not_use_untrusted_proxy_environment(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:8080")

    async def handler(request):
        return httpx.Response(200, json=_EXPECTED)

    app, _ = _app(handler)
    response = TestClient(app).get("/ready")
    assert response.status_code == 200
    assert response.json()["backendLiveVerified"] is True
