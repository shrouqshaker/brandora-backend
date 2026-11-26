"""Provider interfaces. The orchestrator only knows these, never a concrete vendor."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from ..pipeline.context import Ctx
from ..schemas import Plan, RouterResult


class ProviderUnavailable(Exception):
    """The provider could not produce an answer (every model failed, bad key, timeout...)."""

    def __init__(self, reason: str, *, diagnostics=()):
        super().__init__(reason)
        self.reason = reason
        self.diagnostics = tuple(diagnostics)


class RouterProvider(Protocol):
    async def route(self, ctx: Ctx) -> tuple[RouterResult, str | None]:
        """Return (strict router JSON, model used)."""


class GeneratorProvider(Protocol):
    async def generate(self, ctx: Ctx, plan: Plan) -> tuple[str, str | None]:
        """Return (reply text phrased from plan.reply, model used)."""


@dataclass
class Providers:
    name: str                                   # "gemini" | "rules"
    router: RouterProvider
    fallback_router: RouterProvider             # deterministic router used when `router` is unavailable
    generator: GeneratorProvider | None = None
    health: Callable[[], dict[str, Any]] = field(default=lambda: {})
    probe: Callable[[], Awaitable[dict[str, Any]]] | None = None
