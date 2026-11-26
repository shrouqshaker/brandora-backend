"""The whole brain, end to end:

  request -> context (active products only, language, conversation state)
          -> HARD RULES in code (greeting / thanks / confirm / decline): no LLM call at all
          -> ROUTER (small model, strict JSON)  [falls back to the rule router if Gemini is down]
          -> enforce rules on the Router's output (code overrides the model, as in Tamkeen)
          -> PLANNER (catalog, stock, policies -> verified draft + E0-3 candidate)
          -> GENERATOR (larger model rephrases the verified draft in the customer's language)
          -> GUARD (any violation -> send the template draft instead)
          -> E0-3 response (exactly: intent, reply, requiresReview, orderCandidate)
"""
from __future__ import annotations

import logging
import math
import time

from pydantic import ValidationError

from ..config import Settings
from ..nlu import RuleContext, classify_rules, is_decline, is_pure_confirmation, normalize
from ..prompts.templates import t
from ..providers import Providers, ProviderUnavailable
from ..schemas import AiResponse, AIRespondRequest, Confirmation, Intent, Plan, RouterResult
from .context import Ctx, build_context
from .execution import ExecutionResult, Trace
from .guard import check_reply
from .planner import Planner

logger = logging.getLogger("brandora.pipeline")

SHORT_MESSAGE_TOKENS = 5
MAX_PRODUCT_QUERY = 120
MAX_BUDGET = 10_000_000


class AIUnavailable(Exception):
    """The Router failed on every model and rule fallback is disabled (HTTP 503)."""


def enforce_router_rules(rr: RouterResult, ctx: Ctx) -> RouterResult:
    """Code has the last word over the model: sanitise and clamp whatever the Router returned."""
    seen: list[Intent] = []
    for i in rr.intents:
        if i not in seen:
            seen.append(i)
    rr.intents = seen[:3] or [Intent.UNKNOWN]
    rr.confidence = max(0.0, min(1.0, float(rr.confidence)))
    rr.product_query = (rr.product_query or "").strip()[:MAX_PRODUCT_QUERY] or None
    rr.color = (rr.color or "").strip()[:40] or None
    rr.size = (rr.size or "").strip()[:20] or None
    rr.preferred_time = (rr.preferred_time or "").strip()[:80] or None
    if rr.quantity is not None and rr.quantity <= 0:
        rr.quantity = None
    if rr.max_price is not None and not (math.isfinite(rr.max_price) and 0 < rr.max_price < MAX_BUDGET):
        rr.max_price = None   # a budget ceiling must be a sane positive amount
    if rr.faq_id is not None and not 1 <= rr.faq_id <= len(ctx.faqs):
        rr.faq_id = None      # the Router may only point at a FAQ number that exists in the prompt
    if not (ctx.awaiting_confirm or ctx.pending_action):
        rr.confirmation = None   # a yes/no only means something right after we asked for confirmation
    return rr


class Orchestrator:
    def __init__(self, settings: Settings, providers: Providers):
        self.settings = settings
        self.providers = providers

    # ------------------------------------------------------------------ public

    async def respond(self, request: AIRespondRequest) -> ExecutionResult:
        """Execute one request and return its state without storing it on self."""
        started = time.perf_counter()
        # Detach nested catalog, knowledge, and business models from caller-owned
        # objects, even when a caller reuses the same validated request instance.
        request = request.model_copy(deep=True)
        ctx = build_context(request)
        trace = Trace(dropped_inactive=ctx.dropped_inactive)

        plan, rr, confirming = self._hard_rules(ctx)
        if plan is None:
            declined = False
            if rr is None:
                rr, confirming, declined = await self._route(ctx, trace)
            else:
                trace.router_source = "hard-rule"
            plan = self._decline_plan(ctx) if declined else Planner(ctx, self.settings.min_confidence).plan(rr, confirming)
        else:
            trace.router_source = "hard-rule"

        reply = await self._generate(ctx, plan, trace)
        response = self._build_response(plan, reply)

        trace.detailed_intent = plan.detailed_intent.value
        trace.latency_ms = int((time.perf_counter() - started) * 1000)
        logger.info("[DONE] intent=%s->%s source=%s router=%s generator=%s guard=%s llm_calls=%d %dms",
                    plan.detailed_intent.value, response.intent.value, trace.router_source, trace.router_model,
                    trace.generator_model, trace.guard_violations or "ok", trace.llm_calls, trace.latency_ms)
        return ExecutionResult(customer_id=request.customer.id, context=ctx,
                               routing=rr, plan=plan, response=response, trace=trace)

    # ------------------------------------------------------------------ stage 1: hard rules (no LLM)

    @staticmethod
    def _rule_context(ctx: Ctx) -> RuleContext:
        return RuleContext(products=ctx.products, mid_order=ctx.mid_order, awaiting_confirm=ctx.awaiting_confirm,
                           faqs=ctx.faqs)

    @staticmethod
    def _decline_plan(ctx: Ctx) -> Plan:
        """The customer said "no" to our confirmation question: leave everything as it is, create nothing."""
        key = "KEEP_AS_IS" if ctx.pending_action else "DECLINED"
        return Plan(Intent.UNKNOWN, t(ctx.language, key), confidence=0.8)

    def _hard_rules(self, ctx: Ctx) -> tuple[Plan | None, RouterResult | None, bool]:
        text = ctx.text
        if ctx.pending_action:   # we asked: "confirm cancelling / changing order #X?"
            if is_decline(text, ctx.pending_action):
                return self._decline_plan(ctx), None, False
            if is_pure_confirmation(text, ctx.pending_action):
                intent = Intent.ORDER_CANCEL if ctx.pending_action == "cancel" else Intent.ORDER_MODIFY
                return None, RouterResult(intents=[intent], confidence=0.9), True
        elif ctx.awaiting_confirm:   # we asked: "confirm the order?"
            if is_decline(text):
                return self._decline_plan(ctx), None, False
            if is_pure_confirmation(text):
                return None, RouterResult(intents=[Intent.CREATE_ORDER], confidence=0.9), True
        pre = classify_rules(text, self._rule_context(ctx))
        pure = pre.intents and pre.intents[0] in (Intent.GREETING, Intent.THANKYOU) and len(pre.intents) == 1
        if pure and pre.confidence >= 0.8 and len(normalize(text).split()) <= SHORT_MESSAGE_TOKENS:
            return None, pre, False   # greetings / thanks never cost an LLM call
        return None, None, False

    # ------------------------------------------------------------------ stage 2: router

    async def _route(self, ctx: Ctx, trace: Trace) -> tuple[RouterResult, bool, bool]:
        """Run the Router (rule router if Gemini is down). Returns (router result, confirming?, declined?)."""
        try:
            trace.llm_calls += 1 if self.providers.name == "gemini" else 0
            rr, model = await self.providers.router.route(ctx)
            trace.router_source = self.providers.name
            trace.router_model = model
        except ProviderUnavailable as exc:
            logger.warning("router unavailable (%s)", exc.reason)
            if not self.settings.fallback_to_rules:
                raise AIUnavailable(exc.reason) from exc
            rr, _ = await self.providers.fallback_router.route(ctx)
            trace.router_source, trace.fallback_reason = "rules", exc.reason
        # Providers may reuse a result object. Sanitization belongs to this call.
        rr = enforce_router_rules(rr.model_copy(deep=True), ctx)

        confirming = declined = False
        if rr.confirmation is not None:   # only survives enforce_router_rules right after a confirmation question
            sure = rr.confidence >= 0.85 and len(normalize(ctx.text).split()) <= SHORT_MESSAGE_TOKENS
            if sure and rr.confirmation == Confirmation.YES:
                if ctx.pending_action:
                    intent = Intent.ORDER_CANCEL if ctx.pending_action == "cancel" else Intent.ORDER_MODIFY
                else:
                    intent = Intent.CREATE_ORDER
                rr, confirming = RouterResult(intents=[intent], confidence=rr.confidence), True
            elif sure and rr.confirmation == Confirmation.NO:
                declined = True
        return rr, confirming, declined

    # ------------------------------------------------------------------ stage 3: generator + guard

    async def _generate(self, ctx: Ctx, plan: Plan, trace: Trace) -> str:
        gen = self.providers.generator
        if gen is None or not plan.grounded or not self.settings.generator_enabled:
            return plan.reply
        if trace.fallback_reason:
            # The Router just failed on every model, so Gemini is down/unreachable. Don't make the customer wait for a
            # second round of retries: the verified template is already a complete, correct reply.
            return plan.reply
        try:
            trace.llm_calls += 1
            text, model = await gen.generate(ctx, plan)
        except ProviderUnavailable as exc:
            logger.warning("generator unavailable (%s); using the verified template", exc.reason)
            trace.guard_violations = [f"generator unavailable: {exc.reason}"]
            return plan.reply
        problems = check_reply(text, plan, ctx.language)
        if problems:
            logger.warning("generated reply rejected %s; using the verified template", problems)
            trace.guard_violations = problems
            return plan.reply
        trace.generator_model = model
        return text

    # ------------------------------------------------------------------ stage 4: E0-3 output

    def _build_response(self, plan: Plan, reply: str) -> AiResponse:
        try:
            return AiResponse(intent=plan.e03_intent, reply=reply,
                              requiresReview=bool(plan.review_reasons) or plan.owner_review,
                              orderCandidate=plan.candidate)
        except ValidationError:  # should be impossible; never let a bad shape reach the backend
            logger.exception("response failed E0-3 validation; sending the safe fallback")
            from ..schemas import E03Intent
            return AiResponse(intent=E03Intent.OTHER, reply=plan.reply or "…", requiresReview=False, orderCandidate=None)
