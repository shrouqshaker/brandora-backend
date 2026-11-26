"""Reviewed Railway launcher. Fail closed; no legacy providers or proxy wildcard."""
import os
from dataclasses import replace

from .config import ConfigError,load_settings


def create_application():
    settings=load_settings()
    if settings.app_env not in {"staging","production"} or not settings.ai_integration_enabled:
        raise ConfigError("Railway requires explicit APP_ENV staging/production and enabled canonical integration")
    if not settings.trusted_proxy_cidrs and not settings.railway_edge_https_enabled:
        raise ConfigError("Railway requires verified TRUSTED_PROXY_CIDRS or explicit isolated Railway edge HTTPS mode")
    if settings.enable_dev_endpoints:
        raise ConfigError("Railway must not enable development endpoints")
    from .http import create_app
    # Legacy v1 remains in main:app for compatibility testing, never the release
    # launcher. Its model settings cannot activate Gemini in this service.
    return create_app(replace(settings,ai_provider="rules",legacy_api_enabled=False,enable_dev_endpoints=False))


def main():
    import uvicorn
    try:
        port=int(os.getenv("PORT","8080"))
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise ConfigError("PORT must be a valid TCP port") from None
    uvicorn.run(create_application(),host="0.0.0.0",port=port,proxy_headers=False,
                access_log=False,timeout_keep_alive=5,limit_concurrency=64)


if __name__ == "__main__":
    main()
