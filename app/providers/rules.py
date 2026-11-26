"""Deterministic provider: the rule-based Router (no network, no key).

It is a real production component, not a mock: it is the safety net when Gemini is down, and the engine behind
AI_PROVIDER=rules for offline use.
"""
from __future__ import annotations

from ..nlu import RuleContext, classify_rules
from ..pipeline.context import Ctx
from ..schemas import RouterResult


class RulesRouter:
    async def route(self, ctx: Ctx) -> tuple[RouterResult, str | None]:
        rule_ctx = RuleContext(products=ctx.products, mid_order=ctx.mid_order, awaiting_confirm=ctx.awaiting_confirm,
                               faqs=ctx.faqs)
        return classify_rules(ctx.text, rule_ctx), None
