"""Request-owned execution results; never retained on the shared orchestrator.

The frozen envelope prevents accidental replacement of stages. Its nested models
remain mutable within this request; it is not a globally immutable snapshot.
Identifiers describe the existing v1 payload, not verified authorization claims.
"""
from dataclasses import dataclass, field
from uuid import UUID

from ..schemas import AiResponse, Plan, RouterResult
from .context import Ctx


@dataclass
class Trace:
    router_source: str = "rules"
    router_model: str | None = None
    generator_model: str | None = None
    fallback_reason: str | None = None
    detailed_intent: str = ""
    guard_violations: list[str] = field(default_factory=list)
    dropped_inactive: int = 0
    llm_calls: int = 0
    latency_ms: int = 0


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    customer_id: UUID
    context: Ctx = field(repr=False)
    routing: RouterResult | None = field(repr=False)
    plan: Plan = field(repr=False)
    response: AiResponse = field(repr=False)
    trace: Trace

    @property
    def business_id(self) -> UUID:
        return self.context.business.id

    @property
    def message_id(self) -> UUID:
        return self.context.message_id
