"""Environment-driven settings. Nothing secret is ever logged or echoed back."""
from __future__ import annotations

import os
import re
from uuid import UUID
from dataclasses import dataclass, field

from dotenv import load_dotenv

# Dotenv is deliberately opt-in. Production/CI should inject environment values;
# a private .env is never read merely because this module is imported.
def _load_explicit_local_dotenv() -> None:
    app_env = (os.getenv("APP_ENV") or "local").strip().lower()
    opted_in = (os.getenv("LOAD_DOTENV") or "").strip().lower() in {"1", "true", "yes", "on"}
    disabled = (os.getenv("PYTHON_DOTENV_DISABLED") or "").strip().lower() in {"1", "true", "yes", "on"}
    if app_env == "local" and opted_in and not disabled:
        # DOTENV_PATH makes the decision and file explicit; otherwise the normal
        # local .env location is used only after LOAD_DOTENV=true was supplied.
        load_dotenv(dotenv_path=os.getenv("DOTENV_PATH") or ".env", override=False)


# Router = small/fast model (classification + entity extraction, strict JSON).
DEFAULT_ROUTER_MODELS = ("gemini-flash-lite-latest", "gemini-2.5-flash-lite")
# Generator = larger model that phrases the final reply from verified facts.
DEFAULT_GENERATOR_MODELS = ("gemini-flash-latest", "gemini-3.5-flash", "gemini-2.5-flash")


class ConfigError(RuntimeError):
    """Invalid configuration; the service refuses to start (fail fast)."""


def valid_railway_domain(value: object) -> bool:
    """Only the generated public domain for this explicitly configured service."""
    return isinstance(value, str) and re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.up\.railway\.app", value
    ) is not None


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _num(name: str, default: float) -> float:
    raw = os.getenv(name)
    try:
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _models(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    return tuple(m.strip() for m in raw.split(",") if m.strip()) or default


@dataclass(frozen=True)
class Settings:
    ai_provider: str = "gemini"                  # "gemini" (production) | "rules" (deterministic, offline, no key)
    gemini_api_key: str | None = field(default=None, repr=False)
    groq_api_key: str | None = field(default=None, repr=False)
    groq_models: tuple[str, ...] = ("openai/gpt-oss-120b",)
    groq_reasoning_effort: str = "low"           # gpt-oss only: low/medium/high. "low" cuts latency a lot for JSON extraction
    openrouter_api_key: str | None = field(default=None, repr=False)
    openrouter_models: tuple[str, ...] = ("google/gemma-4-31b-it:free",)
    chat_provider_order: tuple[str, ...] = ("groq", "openrouter")
    chat_provider_timeout_seconds: float = 15.0  # per HTTP attempt; gpt-oss-120b is a reasoning model and often needs >3s
    chat_total_timeout_seconds: float = 25.0     # per stage (understanding / reply)
    chat_circuit_seconds: float = 30.0
    router_models: tuple[str, ...] = DEFAULT_ROUTER_MODELS
    generator_models: tuple[str, ...] = DEFAULT_GENERATOR_MODELS
    generator_enabled: bool = True               # false = Router only, replies come straight from the verified templates
    router_temperature: float = 0.0
    generator_temperature: float = 0.3
    gemini_timeout_seconds: float = 12.0         # per call
    gemini_total_timeout_seconds: float = 25.0   # per stage (router / generator), so WhatsApp never waits forever
    gemini_max_retries: int = 2                  # per model, for transient (network/timeout/bad-JSON) errors
    gemini_retry_delay_seconds: float = 3.0
    gemini_cooldown_seconds: float = 60.0        # a model that returned 503/429 is skipped for this long
    ai_service_token: str | None = field(default=None, repr=False)  # Backend -> AI only
    app_env: str = "local"
    products_integration_enabled: bool = False
    ai_integration_enabled: bool = False
    supplied_context_compat_enabled: bool = False
    legacy_api_enabled: bool = False
    trusted_proxy_cidrs: tuple[str, ...] = ()
    railway_edge_https_enabled: bool = False
    railway_public_domain: str | None = None
    railway_project_id: str | None = None
    railway_environment_id: str | None = None
    railway_service_id: str | None = None
    integration_timeout_seconds: float = 25.0
    stock_quantity_disclosure_businesses: tuple[str, ...] = ()
    backend_base_url: str | None = None
    backend_service_token: str | None = field(default=None, repr=False)  # AI -> Backend only
    backend_context_public_key: str | None = field(default=None, repr=False)
    backend_timeout_seconds: float = 5.0
    backend_max_response_bytes: int = 1_048_576
    dependency_readiness_file: str | None = None
    enable_dev_endpoints: bool = False           # /v1/dev/* (mock data playground). Never enable in production.
    fallback_to_rules: bool = True               # Router failed on every model: True = rule router, False = HTTP 503
    min_confidence: float = 0.4
    log_level: str = "INFO"

    @property
    def llm_enabled(self) -> bool:
        return self.ai_provider == "gemini"

    def validate(self) -> "Settings":
        if self.app_env not in {"local", "staging", "production"}:
            raise ConfigError("APP_ENV must be local, staging or production")
        if self.backend_max_response_bytes <= 0:
            raise ConfigError("BACKEND_MAX_RESPONSE_BYTES must be positive")
        if self.railway_edge_https_enabled:
            if self.app_env not in {"staging", "production"} or self.trusted_proxy_cidrs:
                raise ConfigError("Railway edge HTTPS requires staging/production and a separate proxy trust mode")
            if not valid_railway_domain(self.railway_public_domain):
                raise ConfigError("Railway edge HTTPS requires this service's generated RAILWAY_PUBLIC_DOMAIN")
            try:
                for value in (self.railway_project_id, self.railway_environment_id, self.railway_service_id):
                    UUID(value)
            except (ValueError, TypeError, AttributeError):
                raise ConfigError("Railway edge HTTPS requires Railway project, environment and service identities") from None
        if self.app_env != "local" and (not self.ai_service_token or len(self.ai_service_token) < 32
                or not self.ai_service_token.isascii() or not self.ai_service_token.isprintable()
                or self.ai_service_token.strip() != self.ai_service_token
                or self.enable_dev_endpoints or self.legacy_api_enabled):
            raise ConfigError("Staging/production requires a strong AI_SERVICE_TOKEN and disabled legacy/dev endpoints")
        if self.ai_provider not in {"gemini", "rules"}:
            raise ConfigError(f"AI_PROVIDER must be 'gemini' or 'rules' (got {self.ai_provider!r})")
        if self.ai_provider == "gemini" and not self.gemini_api_key:
            raise ConfigError("AI_PROVIDER=gemini requires GEMINI_API_KEY (or set AI_PROVIDER=rules for the offline engine)")
        return self


def load_settings() -> Settings:
    _load_explicit_local_dotenv()
    return Settings(
        ai_provider=(os.getenv("AI_PROVIDER") or "gemini").strip().lower(),
        gemini_api_key=(os.getenv("GEMINI_API_KEY") or "").strip() or None,
        groq_api_key=(os.getenv("GROQ_API_KEY") or "").strip() or None,
        groq_models=_models("GROQ_MODELS", ("openai/gpt-oss-120b",)),
        groq_reasoning_effort=(os.getenv("GROQ_REASONING_EFFORT") or "low").strip().lower(),
        openrouter_api_key=(os.getenv("OPENROUTER_API_KEY") or "").strip() or None,
        openrouter_models=_models("OPENROUTER_MODELS", ("google/gemma-4-31b-it:free",)),
        chat_provider_order=_models("CHAT_PROVIDER_ORDER", ("groq", "openrouter")),
        chat_provider_timeout_seconds=_num("CHAT_PROVIDER_TIMEOUT_SECONDS", 15.0),
        chat_total_timeout_seconds=_num("CHAT_TOTAL_TIMEOUT_SECONDS", 25.0),
        chat_circuit_seconds=_num("CHAT_CIRCUIT_SECONDS", 30.0),
        router_models=_models("ROUTER_MODELS", DEFAULT_ROUTER_MODELS),
        generator_models=_models("GENERATOR_MODELS", DEFAULT_GENERATOR_MODELS),
        generator_enabled=_bool("GENERATOR_ENABLED", True),
        router_temperature=_num("ROUTER_TEMPERATURE", 0.0),
        generator_temperature=_num("GENERATOR_TEMPERATURE", 0.3),
        gemini_timeout_seconds=_num("GEMINI_TIMEOUT_SECONDS", 12.0),
        gemini_total_timeout_seconds=_num("GEMINI_TOTAL_TIMEOUT_SECONDS", 25.0),
        gemini_max_retries=_int("GEMINI_MAX_RETRIES", 2),
        gemini_retry_delay_seconds=_num("GEMINI_RETRY_DELAY_SECONDS", 3.0),
        gemini_cooldown_seconds=_num("GEMINI_COOLDOWN_SECONDS", 60.0),
        ai_service_token=(os.getenv("AI_SERVICE_TOKEN") or "").strip() or None,
        app_env=(os.getenv("APP_ENV") or "local").strip().lower(),
        products_integration_enabled=_bool("PRODUCTS_INTEGRATION_ENABLED", False),
        ai_integration_enabled=_bool("AI_INTEGRATION_ENABLED", False),
        supplied_context_compat_enabled=_bool("SUPPLIED_CONTEXT_COMPAT_ENABLED", False),
        legacy_api_enabled=_bool("LEGACY_API_ENABLED", False),
        trusted_proxy_cidrs=_models("TRUSTED_PROXY_CIDRS", ()),
        railway_edge_https_enabled=_bool("RAILWAY_EDGE_HTTPS_ENABLED", False),
        railway_public_domain=os.getenv("RAILWAY_PUBLIC_DOMAIN"),
        railway_project_id=os.getenv("RAILWAY_PROJECT_ID"),
        railway_environment_id=os.getenv("RAILWAY_ENVIRONMENT_ID"),
        railway_service_id=os.getenv("RAILWAY_SERVICE_ID"),
        integration_timeout_seconds=_num("INTEGRATION_TIMEOUT_SECONDS", 25.0),
        stock_quantity_disclosure_businesses=_models("STOCK_QUANTITY_DISCLOSURE_BUSINESSES", ()),
        backend_base_url=(os.getenv("BACKEND_BASE_URL") or "").strip() or None,
        backend_service_token=(os.getenv("BACKEND_SERVICE_TOKEN") or "").strip() or None,
        backend_context_public_key=(os.getenv("BACKEND_CONTEXT_PUBLIC_KEY") or "").replace("\\n", "\n").strip() or None,
        backend_timeout_seconds=_num("BACKEND_TIMEOUT_SECONDS", 5.0),
        backend_max_response_bytes=_int("BACKEND_MAX_RESPONSE_BYTES", 1_048_576),
        dependency_readiness_file=(os.getenv("DEPENDENCY_READINESS_FILE") or "").strip() or None,
        enable_dev_endpoints=_bool("ENABLE_DEV_ENDPOINTS", False),
        fallback_to_rules=_bool("AI_FALLBACK_TO_RULES", True),
        min_confidence=_num("MIN_CONFIDENCE", 0.4),
        log_level=(os.getenv("LOG_LEVEL") or "INFO").upper(),
    )
