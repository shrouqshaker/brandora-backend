"""Request-local assembly reused by offline chat and opt-in Products HTTP.

Caller-established scope/turn bindings are internal assertions, not signed-token
verification. Credentials live only in this call's budgeted data-access wrapper.
"""
import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
import math
import time
from typing import Callable

from pydantic import Field, ValidationError, model_validator

from ..data.backend import BackendDataAccess
from ..data.history import HistoryLimits, HistoryService, PreparedHistory, is_contextual_followup
from ..data.retrieval import RetrievalCoordinator, RetrievalDecision, RetrievalLimits, RetrievalResult
from ..providers.evidence import EvidenceResponder, GroundedGeneration
from ..schemas.backend import BackendModel, ExpectedScope, Identifier, RetrievalOutcome, RetrievalStatus
from ..schemas.inquiry import Inquiry
from ..schemas.response import AiResponse
from .evidence_planner import EvidencePlan, EvidencePlanner, Resolution
from .extensions import DisabledOrderExtension, reserve_order_extension


class TurnBinding(BackendModel):
    scope: ExpectedScope = Field(repr=False)
    message_id: Identifier = Field(repr=False)
    products_only: bool = False

    @model_validator(mode="after")
    def complete_scope(self):
        if not self.products_only and (self.scope.customer_id is None or self.scope.conversation_id is None):
            raise ValueError("Standalone execution requires customer and conversation scope")
        return self


@dataclass(frozen=True)
class BoundHistory:
    binding: TurnBinding = field(repr=False)
    prepared: PreparedHistory = field(repr=False)


@dataclass(frozen=True)
class ExecutionLimits:
    max_elapsed_seconds: float = 20.0
    max_backend_calls: int = 12

    def __post_init__(self):
        if type(self.max_backend_calls) is not int or self.max_backend_calls <= 0:
            raise ValueError("Total Backend call budget must be a positive integer")
        if (isinstance(self.max_elapsed_seconds, bool)
                or not isinstance(self.max_elapsed_seconds, (int, float))
                or not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0):
            raise ValueError("Total execution deadline must be positive and finite")


@dataclass(frozen=True)
class ExecutionDiagnostics:
    backend_calls: int
    elapsed_ms: int
    completed_stages: tuple[str, ...]
    stopped_stage: str | None
    issues: tuple[str, ...]
    generation_source: str
    fallback_reason: str | None


@dataclass(frozen=True)
class StandaloneExecutionResult:
    response: AiResponse = field(repr=False)
    binding: TurnBinding = field(repr=False)
    inquiry: Inquiry = field(repr=False)
    history: BoundHistory | None = field(repr=False)
    retrieval: RetrievalResult = field(repr=False)
    plan: EvidencePlan = field(repr=False)
    generation: GroundedGeneration = field(repr=False)
    diagnostics: ExecutionDiagnostics
    order_extension: DisabledOrderExtension = field(default_factory=DisabledOrderExtension, repr=False)


_AUTH = frozenset({RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH})


class _RequestData:
    """One request's immutable identity and cumulative operation/time budget."""
    def __init__(self, data, scope, token, deadline, limits, clock):
        self.data, self.scope, self.token = data, scope, token
        self.deadline, self.limits, self.clock = deadline, limits, clock
        self.calls = 0
        self.issues = []
        self.rejection = None

    async def _call(self, name, args, scope, token):
        if self.rejection is not None:
            return RetrievalOutcome(status=self.rejection, error=self.rejection.value)
        if scope != self.scope or token != self.token:
            self.rejection = RetrievalStatus.SCOPE_MISMATCH
            return RetrievalOutcome(status=self.rejection, error="scope_mismatch")
        if self.clock() >= self.deadline:
            self.issues.append("total_time_limit")
            return RetrievalOutcome(status=RetrievalStatus.UNAVAILABLE, error="timeout")
        if self.calls >= self.limits.max_backend_calls:
            self.issues.append("total_call_limit")
            return RetrievalOutcome(status=RetrievalStatus.UNAVAILABLE, error="backend_error")
        self.calls += 1
        result = await getattr(self.data, name)(*args, scope=scope, context_token=token)
        if result.status in _AUTH:
            self.rejection = result.status
        return result

    async def get_conversation_history(self, conversation_id, limit=20, offset=0, *, scope, context_token):
        return await self._call("get_conversation_history", (conversation_id, limit, offset), scope, context_token)

    async def get_products(self, limit=20, offset=0, *, scope, context_token):
        return await self._call("get_products", (limit, offset), scope, context_token)

    async def get_product_details(self, product_id, *, scope, context_token):
        return await self._call("get_product_details", (product_id,), scope, context_token)

    async def get_product_variants(self, product_id, limit=20, offset=0, *, scope, context_token):
        return await self._call("get_product_variants", (product_id, limit, offset), scope, context_token)

    async def get_variant_details(self, product_id, variant_id, *, scope, context_token):
        return await self._call("get_variant_details", (product_id, variant_id), scope, context_token)

    async def get_business_info(self, *, scope, context_token):
        return await self._call("get_business_info", (), scope, context_token)


class StandalonePipeline:
    def __init__(self, data: BackendDataAccess, generator: EvidenceResponder, *,
                 planner: EvidencePlanner | None = None, limits: ExecutionLimits | None = None,
                 history_limits: HistoryLimits | None = None, retrieval_limits: RetrievalLimits | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self._data, self._generator = data, generator
        self._planner = planner or EvidencePlanner()
        self._limits = limits or ExecutionLimits()
        self._history_limits = history_limits or HistoryLimits()
        self._retrieval_limits = retrieval_limits or RetrievalLimits()
        self._clock = clock

    def _bounded_history(self, prepared: PreparedHistory) -> bool:
        """Supplied context must not bypass the configured preparation bounds."""
        if not isinstance(prepared, PreparedHistory):
            return False
        if prepared.failure is not None and not isinstance(prepared.failure, RetrievalStatus):
            return False
        if len(prepared.messages) + len(prepared.uncertain_messages) > self._history_limits.max_messages or len(prepared.references) > self._history_limits.max_messages:
            return False
        characters = 0
        for turn in (*prepared.messages, *prepared.uncertain_messages):
            characters += len(turn.content or "")
            if characters > self._history_limits.max_characters:
                return False
        hint_characters = 0
        for hint in prepared.references:
            for term in (*hint.product_terms, hint.color or "", hint.size or ""):
                hint_characters += len(term)
                if hint_characters > self._history_limits.max_characters:
                    return False
        return True

    async def execute(self, inquiry: Inquiry, *, scope: ExpectedScope, message_id,
                      context_token: str, history: BoundHistory | None = None,
                      prepare_history: bool = True, products_only: bool = False) -> StandaloneExecutionResult:
        started = self._clock()
        if type(products_only) is not bool or (products_only and (prepare_history or history is not None)):
            raise ValueError("Products-only execution cannot prepare or accept history")
        binding = TurnBinding(scope=scope, message_id=message_id, products_only=products_only)
        if type(prepare_history) is not bool:
            raise ValueError("History preparation flag must be a boolean")
        # JSON validation detaches all input containers; the shared immutable
        # inquiry instance below is passed unchanged to retrieval and planning.
        query = Inquiry.model_validate(inquiry.model_dump(mode="json"))
        if (not isinstance(context_token, str) or not context_token.strip()
                or any(not 32 <= ord(char) < 127 for char in context_token)):
            raise ValueError("Invalid per-call context token")
        data = _RequestData(self._data, binding.scope, context_token,
                            started + self._limits.max_elapsed_seconds, self._limits, self._clock)
        prepared = None
        retrieved = None
        plan = None
        generation = None
        stages, issues = [], []
        stage = "binding"
        stopped = None

        def failure(status, issue):
            nonlocal prepared
            if status in _AUTH:
                prepared = None
            return RetrievalResult(RetrievalDecision.PRODUCTS, status=status, failure=status,
                                   issues=(issue,), inquiry=query)

        def check_time():
            if self._clock() >= data.deadline:
                raise asyncio.TimeoutError

        async def run():
            nonlocal prepared, retrieved, plan, generation, stage
            if history is not None and history.binding != binding:
                retrieved = failure(RetrievalStatus.SCOPE_MISMATCH, "history_binding_mismatch")
                issues.append("history_binding_mismatch")
            elif history is not None and not self._bounded_history(history.prepared):
                retrieved = failure(RetrievalStatus.INVALID, "supplied_history_limit")
                issues.append("supplied_history_limit")
            else:
                if history is not None:
                    prepared = BoundHistory(binding, deepcopy(history.prepared))
                elif prepare_history and is_contextual_followup(query.text):
                    stage = "history"
                    check_time()
                    value = await HistoryService(data, self._history_limits, self._clock).prepare(
                        binding.scope.conversation_id, str(binding.message_id), query.text,
                        scope=binding.scope, context_token=context_token)
                    prepared = BoundHistory(binding, value)
                    stages.append("history")
                stage = "retrieval"
                check_time()
                history_failure = prepared.prepared.failure if prepared else None
                if history_failure in _AUTH:
                    retrieved = failure(history_failure, history_failure.value)
                else:
                    retrieved = await RetrievalCoordinator(data, self._retrieval_limits, self._clock).retrieve(
                        query, scope=binding.scope, context_token=context_token,
                        history=prepared.prepared if prepared else None, history_scope=binding.scope if prepared else None)
                stages.append("retrieval")
                if retrieved.failure in _AUTH or data.rejection is not None:
                    retrieved = failure(data.rejection or retrieved.failure, "authorization_rejected")
                elif retrieved.inquiry != query:
                    retrieved = failure(RetrievalStatus.INVALID, "retrieval_inquiry_mismatch")
            stage = "planning"
            check_time()
            plan = self._planner.plan(query, retrieved, prepared.prepared if prepared else None)
            stages.append("planning")
            if plan.resolution in {Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH}:
                status = RetrievalStatus.AUTHORIZATION_FAILED if plan.resolution == Resolution.AUTHORIZATION_FAILED else RetrievalStatus.SCOPE_MISMATCH
                retrieved = failure(status, "authorization_rejected")
                plan = self._planner.plan(query, retrieved)
            stage = "generation"
            check_time()
            generation = await self._generator.generate(plan)
            stages.append("generation")

        try:
            remaining = data.deadline - self._clock()
            if remaining <= 0:
                raise asyncio.TimeoutError
            await asyncio.wait_for(run(), timeout=remaining)
            check_time()
        except asyncio.TimeoutError:
            stopped = stage
            issues.append("total_time_limit")
            if data.rejection is not None:
                retrieved = failure(data.rejection, "authorization_rejected")
                plan = None
            if plan is None:
                # No incomplete stage's partial protected data escapes on timeout.
                prepared = None
                retrieved = failure(data.rejection or RetrievalStatus.UNAVAILABLE, "total_time_limit")
                plan = self._planner.plan(query, retrieved)
            generation = self._generator.fallback(plan, "total_execution_timeout")
        # Caller cancellation is deliberately not caught.
        try:
            response = AiResponse.model_validate(generation.response.model_dump(mode="json"))
            invalid_generation = (response.orderCandidate is not None or response.intent.value == "CONFIRMED_ORDER"
                                  or response.intent != plan.intent or response.requiresReview != plan.requires_review)
        except (ValidationError, ValueError, TypeError, AttributeError):
            invalid_generation = True
        if invalid_generation:
            generation = self._generator.fallback(plan, "invalid_generation_result")
            response = generation.response
        diagnostics = ExecutionDiagnostics(
            data.calls, max(0, int((self._clock() - started) * 1000)), tuple(stages), stopped,
            tuple(dict.fromkeys(issues + data.issues + list(retrieved.issues))),
            generation.source, generation.fallback_reason)
        return StandaloneExecutionResult(response, binding, query, prepared, retrieved, plan, generation, diagnostics,
                                         order_extension=reserve_order_extension(plan, query.option_values))
