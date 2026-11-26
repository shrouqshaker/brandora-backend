"""Provider factory: AI_PROVIDER=gemini -> real Gemini (Router + Generator); AI_PROVIDER=rules -> deterministic router."""
from __future__ import annotations

from ..config import ConfigError, Settings
from .base import Providers, ProviderUnavailable, GeneratorProvider, RouterProvider  # noqa: F401
from .rules import RulesRouter


def build_providers(settings: Settings, client=None) -> Providers:
    settings.validate()
    if settings.ai_provider == "rules":
        return Providers(name="rules", router=RulesRouter(), fallback_router=RulesRouter(), generator=None,
                         health=lambda: {"provider": "rules", "models": []})
    if settings.ai_provider == "gemini":
        from .gemini import GeminiClient, GeminiGenerator, GeminiRouter

        client = client or GeminiClient(settings)
        return Providers(
            name="gemini", router=GeminiRouter(client, settings), fallback_router=RulesRouter(),
            generator=GeminiGenerator(client, settings) if settings.generator_enabled else None,
            health=lambda: {"provider": "gemini", "models": client.snapshot()}, probe=client.probe)
    raise ConfigError(f"unknown AI_PROVIDER {settings.ai_provider!r}")
