"""Loopback-only local integration runner.

This module is deliberately separate from the production launcher. It exists for
repeatable Backend/AI/PostgreSQL verification and never enables legacy or dev
routes. Configuration must be supplied explicitly with ``--env-file`` or the
calling process environment; no implicit dotenv loading is performed.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from urllib.parse import urlparse

from .config import ConfigError, load_settings


def _load_env_file(path: str) -> None:
    """Load a private dotenv fragment without overriding the process environment."""
    env_path = Path(path).expanduser().resolve()
    if not env_path.is_file():
        raise ConfigError(f"local env file does not exist: {env_path}")
    for number, raw in enumerate(env_path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ConfigError(f"invalid local env line {number}")
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_" for ch in key):
            raise ConfigError(f"invalid local env key on line {number}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _require_local_configuration() -> None:
    if (os.getenv("APP_ENV") or "").strip().lower() != "local":
        raise ConfigError("local runner requires APP_ENV=local")
    if (os.getenv("AI_LOCAL_ENABLED") or "").strip().lower() not in {"1", "true", "yes", "on"}:
        raise ConfigError("local runner requires AI_LOCAL_ENABLED=true")
    if (os.getenv("ENABLE_DEV_ENDPOINTS") or "false").strip().lower() in {"1", "true", "yes", "on"}:
        raise ConfigError("local runner never enables development endpoints")
    if (os.getenv("LEGACY_API_ENABLED") or "false").strip().lower() in {"1", "true", "yes", "on"}:
        raise ConfigError("local runner never enables legacy endpoints")
    backend = (os.getenv("BACKEND_BASE_URL") or "").strip()
    parsed = urlparse(backend)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ConfigError("local runner requires a loopback BACKEND_BASE_URL")


def create_application():
    _require_local_configuration()
    from .http import create_app

    provider = (os.getenv("AI_LOCAL_PROVIDER") or "rules").strip().lower()
    if provider not in {"rules", "groq"}:
        raise ConfigError("AI_LOCAL_PROVIDER must be 'rules' (no model calls) or 'groq' (real GroqCloud, needs GROQ_API_KEY)")
    if provider == "groq" and not (os.getenv("GROQ_API_KEY") or "").strip():
        raise ConfigError("AI_LOCAL_PROVIDER=groq requires GROQ_API_KEY")
    # The canonical /v2/ai/respond route never uses the legacy Gemini provider; it
    # calls GroqCloud whenever a key is configured and otherwise stays deterministic.
    os.environ["AI_PROVIDER"] = "rules"
    os.environ["AI_INTEGRATION_ENABLED"] = "true"
    os.environ["PRODUCTS_INTEGRATION_ENABLED"] = "false"
    os.environ["LEGACY_API_ENABLED"] = "false"
    os.environ["ENABLE_DEV_ENDPOINTS"] = "false"
    if provider == "rules":
        os.environ.pop("GROQ_API_KEY", None)  # rules mode must never reach a model
    settings = load_settings().validate()
    if not settings.ai_integration_enabled:
        raise ConfigError("local runner requires AI_INTEGRATION_ENABLED=true")
    if settings.trusted_proxy_cidrs:
        raise ConfigError("local runner does not accept trusted proxy CIDRs")
    print(f"[brandora-ai] local runner | llm={'groq:' + ','.join(settings.groq_models) if settings.groq_api_key else 'OFF (deterministic rules)'} | backend={settings.backend_base_url}", flush=True)
    return create_app(settings)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run Brandora AI on loopback for local integration tests")
    parser.add_argument("--env-file", help="explicit private dotenv fragment")
    args = parser.parse_args(argv)
    if args.env_file:
        _load_env_file(args.env_file)
    _require_local_configuration()
    try:
        port = int(os.getenv("AI_LOCAL_PORT", "8000"))
    except ValueError:
        raise ConfigError("AI_LOCAL_PORT must be an integer") from None
    if not 1 <= port <= 65535:
        raise ConfigError("AI_LOCAL_PORT must be between 1 and 65535")
    import uvicorn

    uvicorn.run(
        create_application(),
        host="127.0.0.1",
        port=port,
        proxy_headers=False,
        access_log=False,
        timeout_keep_alive=5,
        limit_concurrency=64,
    )


if __name__ == "__main__":
    main()
