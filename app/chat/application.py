"""Session-owned conversational composition over the existing standalone stack."""
import asyncio
from dataclasses import asdict, dataclass, field, replace
from uuid import uuid4

from ..data.options import resolve_options
from ..data.retrieval import RetrievalDecision
from ..nlu import extract_entities
from ..pipeline.standalone import StandalonePipeline, StandaloneExecutionResult
from ..pipeline.evidence_planner import EvidencePlanner, Resolution, GroundedStatement, EvidenceSource
from ..schemas.response import E03Intent, ReviewReason
from ..pipeline.price_comparison import compare_verified_pair
from ..schemas.backend import InventoryState
from ..schemas.backend import ExpectedScope
from .understanding import ConversationInterpreter, Selection, Understood, declines_selection, asks_stock_quantity


@dataclass(frozen=True)
class ChatTurn:
    execution: StandaloneExecutionResult = field(repr=False)
    understanding: Understood = field(repr=False)
    tools: tuple[str, ...]

    @property
    def response(self):
        return self.execution.response

    def diagnostics(self):
        e = self.execution
        return {"intent": self.response.intent.value, "understanding": self.understanding.source,
                "understandingProvider": self.understanding.source.split("_")[0],
                "replyProvider": (e.diagnostics.generation_source.split("_")[0]
                                  if e.diagnostics.generation_source in {"gemini_conversation","groq_conversation","openrouter_conversation"} else "deterministic"),
                "tools": self.tools, "candidates": [p.name for p in e.retrieval.candidates],
                "matchingVariants": [str(v) for v in e.plan.matching_variant_ids],
                "selectedVariant": str(e.plan.selected_variant_id) if e.plan.selected_variant_id else None,
                "clarification": e.plan.requires_clarification, "resolution": e.plan.resolution.value,
                "fallback": self.understanding.fallback or e.diagnostics.fallback_reason,
                "understandingFailure": self.understanding.fallback,
                "replyFailure": e.diagnostics.fallback_reason,
                "providerFailures": {
                    "understanding": [asdict(d) for d in self.understanding.provider_diagnostics],
                    "reply": [asdict(d) for d in e.generation.provider_diagnostics]},
                "source": e.diagnostics.generation_source, "ordersEnabled": False,
                "backendCalls": e.diagnostics.backend_calls,
                "understandingMs": self.understanding.elapsed_ms,
                "executionMs": e.diagnostics.elapsed_ms,
                "elapsedMs": e.diagnostics.elapsed_ms + self.understanding.elapsed_ms,
                "quantity": e.plan.requested_quantity}


class ChatSession:
    """One explicitly scoped conversation. Serialize its turns; no global registry.

    This local caller establishes scope, not authentication. A production caller
    must authenticate scope and persist/version these hints server-side. No raw
    historical assistant prose, prices or stock are used to prepare a follow-up.
    """
    def __init__(self, data, scope: ExpectedScope, interpreter: ConversationInterpreter, responder, *,
                 initial_selection=None,repeat_current_price=False):
        self.scope, self.interpreter = scope, interpreter
        self._data, self._responder = data, responder
        self.selection = initial_selection or Selection()
        self._repeat_current_price=repeat_current_price
        self._lock = asyncio.Lock()

    async def reset(self):
        async with self._lock:
            self.selection = Selection()

    async def send(self, text: str, *, context_token: str, message_id=None,prepared_understanding=None) -> ChatTurn:
        async with self._lock:
            understood = prepared_understanding or await self.interpreter.understand(text, self.selection)
            pipeline = StandalonePipeline(self._data, self._responder, planner=ConversationPlanner(
                understood,self.selection,repeat_current_price=self._repeat_current_price,
                allow_stock_quantity_disclosure=(asks_stock_quantity(text) and
                    str(self.scope.business_id) in self.interpreter.settings.stock_quantity_disclosure_businesses)))
            execution = await pipeline.execute(understood.inquiry, scope=self.scope,
                message_id=message_id or uuid4(), context_token=context_token, prepare_history=False)
            # Intent, language and quantity are semantic customer requests, not
            # Backend facts. Keep the planner's safety decisions authoritative.
            # Quantity extraction from canonical text is checked by regression tests.
            if execution.retrieval.failure is not None:
                self.selection = Selection()
            elif execution.retrieval.candidates:
                products = tuple(p.model_copy(deep=True) for p in execution.retrieval.candidates)
                options = ()
                if len(products) == 1:
                    options = resolve_options(products[0], understood.inquiry.text,
                                              understood.inquiry.option_values).values
                alternatives=(tuple((key,tuple(values)) for key,values in understood.inquiry.option_alternatives.items())
                              if understood.meaning.act=="compare" else ())
                self.selection = Selection(products, options, understood.meaning.quantity,alternatives)
            elif understood.meaning.act != "other":
                self.selection = Selection()
            elif declines_selection(text):
                self.selection = Selection()
            elif (execution.retrieval.decision == RetrievalDecision.CLARIFY
                  and extract_entities(text).product_tokens):
                # An unresolved new topic must not leave an old purchase ready
                # for an accidental subsequent "one of it" reference.
                self.selection = Selection()
            tools = tuple(dict.fromkeys(out.envelope.tool for out in execution.retrieval.evidence if out.envelope))
            return ChatTurn(execution, understood, tools)


class ConversationPlanner(EvidencePlanner):
    """Per-turn language/quantity from interpretation, facts from the base planner."""
    def __init__(self, understood, previous=None, *, repeat_current_price=False,allow_stock_quantity_disclosure=False):
        self._meaning = understood.meaning
        self._previous = previous or Selection()
        self._repeat_current_price=repeat_current_price
        self._allow_stock_quantity_disclosure=allow_stock_quantity_disclosure

    def plan(self, inquiry, result, history=None):
        plan = super().plan(inquiry, result, history)
        if declines_selection(inquiry.text):
            reply = ("تمام، نسيب الاختيار ده. تحب تشوف حاجة تانية؟" if self._meaning.language == "ar"
                     else "Okay, we'll leave that option. Would you like to look at something else?")
            return replace(plan, intent=E03Intent.OTHER, language=self._meaning.language,
                           resolution=Resolution.SIMPLE_RESPONSE, requires_clarification=False,
                           requested_quantity=None, statements=(GroundedStatement("hard_rule", reply,
                               (EvidenceSource("deterministic_template", None, "read_only_safety"),)),))
        if self._meaning.act == "other":
            return plan
        plan = replace(plan, language=self._meaning.language, requested_quantity=self._meaning.quantity,
                       allow_stock_quantity_disclosure=self._allow_stock_quantity_disclosure,
                       comparison_metric=self._meaning.comparison_metric,
                       comparison_alternatives=tuple((key,tuple(values)) for key,values in inquiry.option_alternatives.items()),
                       comparison=self._meaning.act == "compare",reply_script=self._meaning.script,
                       reply_focus=("comparison" if self._meaning.act == "compare" else
                           "purchase" if self._meaning.act == "purchase" else "price" if self._meaning.act == "price" and self._meaning.focus == "discovery"
                           else self._meaning.focus))
        if self._meaning.act == "purchase" and self._meaning.product_handle is not None:
            previous_prices = {v.id:v.effectivePrice for p in self._previous.products for v in p.variants}
            # Earlier observations only determine whether a changed price needs
            # disclosing. All quoted values still come from the fresh plan.
            changed = any(previous_prices.get(v.variant_id) != v.effective_price for v in plan.variants
                          if v.variant_id in plan.matching_variant_ids)
            selections_changed = dict(inquiry.option_values) != dict(self._previous.options)
            plan = replace(plan,show_price=changed or selections_changed or self._repeat_current_price)
        if (plan.resolution == Resolution.SINGLE_VARIANT and not plan.missing_facts
                and not plan.ambiguities and not set(plan.limitations) - {
                    "recorded_observations_not_reservations", "no_stable_snapshot"} and not result.failure):
            variant = next(v for v in plan.variants if v.variant_id in plan.matching_variant_ids)
            # A complete read-only purchase enquiry doesn't need the legacy
            # generic clarification. Selection remains distinct from an order.
            selected = variant.variant_id if variant.inventory == InventoryState.RECORDED_POSITIVE else None
            plan = replace(plan, requires_clarification=False, selected_variant_id=selected)
        if compare_verified_pair(plan) is not None:
            plan = replace(plan,requires_clarification=False,selected_variant_id=None)
        matches=[v for v in plan.variants if v.variant_id in plan.matching_variant_ids]
        if (plan.intent==E03Intent.PURCHASE_INTENT and plan.resolution==Resolution.SINGLE_VARIANT
                and len(plan.products)==len(matches)==1 and not plan.ambiguities and not result.failure
                and not set(plan.limitations)-{"recorded_observations_not_reservations","no_stable_snapshot"}):
            variant=matches[0]
            if (variant.active and variant.parent_active and variant.options_verified
                    and variant.recorded_quantity is not None and plan.requested_quantity is not None
                    and plan.requested_quantity>variant.recorded_quantity):
                plan=replace(plan,requires_review=True,review_reason=ReviewReason.OUT_OF_STOCK_RISK)
        return plan
