"""Bounded, authenticated Backend readiness probe.

The probe is deliberately separate from the AI model/provider health checks. It
uses the AI-to-Backend service credential, never sends a context token, follows
no redirects, ignores proxy environment variables, and returns only the exact
health contract accepted by phase 2.
"""
from __future__ import annotations

import asyncio
import json
import math
from typing import Any

import httpx


_HEALTH_CONTRACT = {
    "status": "ready",
    "database": "up",
    "contract": "conversation-tools-v1",
}
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class BackendHealthProbe:
    """One bounded GET per readiness request; no retries or shared response state."""

    def __init__(
        self,
        base_url: str,
        service_token: str,
        *,
        timeout: float = 5.0,
        max_response_bytes: int = 1_048_576,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        try:
            url = httpx.URL(base_url)
        except (TypeError, httpx.InvalidURL):
            raise ValueError("Invalid Backend base URL") from None
        if (
            url.scheme not in {"http", "https"}
            or not url.host
            or url.userinfo
            or url.query
            or url.fragment
            or url.path not in {"", "/"}
        ):
            raise ValueError("Backend base URL must be an HTTP(S) origin")
        if url.scheme == "http" and url.host not in _LOCAL_HOSTS:
            raise ValueError("Nonlocal Backend origins require HTTPS")
        if (
            not isinstance(service_token, str)
            or not service_token
            or service_token != service_token.strip()
            or not service_token.isascii()
            or not service_token.isprintable()
            or any(ord(char) < 32 or ord(char) >= 127 for char in service_token)
        ):
            raise ValueError("Invalid Backend service token")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("Backend health timeout must be positive and finite")
        if type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 64 * 1024 * 1024:
            raise ValueError("Backend health response cap is invalid")

        self._endpoint = str(url.copy_with(path="/internal/ai/health"))
        self._service_token = service_token
        self._timeout = float(timeout)
        self._max_response_bytes = max_response_bytes
        self._transport = transport

    async def _read_bounded_json(self, response: httpx.Response) -> Any:
        declared = response.headers.get("Content-Length")
        if declared is not None:
            try:
                length = int(declared)
            except (TypeError, ValueError):
                raise ValueError("invalid response length") from None
            if length < 0 or length > self._max_response_bytes:
                raise ValueError("response exceeds byte limit")

        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > self._max_response_bytes:
                raise ValueError("response exceeds byte limit")
            chunks.append(chunk)
        if declared is not None and int(declared) != total:
            raise ValueError("invalid response length")
        try:
            return json.loads(b"".join(chunks).decode("utf-8"))
        except (ValueError, UnicodeError):
            raise ValueError("invalid JSON") from None

    async def check(self) -> dict[str, str] | None:
        """Return the exact Backend health object, or ``None`` on any failure."""
        try:
            # httpx's per-operation timeout does not provide a total deadline for
            # custom transports, so asyncio.timeout is the authoritative bound.
            async with asyncio.timeout(self._timeout):
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self._timeout),
                    transport=self._transport,
                    follow_redirects=False,
                    trust_env=False,
                ) as client:
                    async with client.stream(
                        "GET",
                        self._endpoint,
                        headers={
                            "Authorization": f"Bearer {self._service_token}",
                            "Accept": "application/json",
                        },
                    ) as response:
                        if response.status_code != 200:
                            return None
                        payload = await self._read_bounded_json(response)
            if payload != _HEALTH_CONTRACT:
                return None
            return dict(_HEALTH_CONTRACT)
        except Exception:
            # Readiness must fail closed without exposing transport, response or
            # credential details. asyncio.CancelledError is not an Exception on
            # supported Python versions, so caller cancellation still propagates.
            return None


__all__ = ["BackendHealthProbe"]
