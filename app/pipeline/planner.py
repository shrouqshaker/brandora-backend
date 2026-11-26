"""The business-rules stage. Input: the Router's JSON + the request context. Output: a Plan.

Everything factual (what exists, prices, stock, totals, hours, delivery policy) is resolved HERE from the real data
the backend sent. The Generator may only rephrase the draft; it can never introduce a fact.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from ..nlu import (COLOR_DISPLAY, STRONG_FAQ_SCORE, WEAK_FAQ_SCORE, budget_products, colors_are_a_choice,
                   detect_faq_topic, extract_entities, find_products, has_color, in_stock, is_service_item, match_faq,
                   norm_color, norm_size, normalize, product_colors, product_sizes, search_products,
                   sizes_are_a_choice, within_budget)
from ..prompts.templates import DAYS, STATUS, WEEK_ORDER, t
from ..schemas import (OWNER_REVIEW_INTENTS, CatalogItem, FaqTopic, Intent, Language, OrderCandidate,
                       OrderCandidateItem, Plan, ReviewReason, RouterResult)
from .context import ACTIVE_ORDER_STATUSES, Ctx

LOW_STOCK_THRESHOLD = 3
MAX_LIST = 6
MAX_QUANTITY = 100            # E0-3: quantity is an integer between 1 and 100
CARRY_OVER_MESSAGES = 4
ACTIVE_STATUSES = ACTIVE_ORDER_STATUSES


# ----------------------------------------------------------------------------- formatting helpers


def fmt_money(value: Decimal | None) -> str | None:
    if value is None:
        return None
    value = Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return str(int(value)) if value == value.to_integral() else f"{value:.2f}".rstrip("0")


def _as_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except ValueError:
        return None


@dataclass
class Slots:
    quantity: int | None = None
    color: str | None = None          # normalised colour key ("اسود")
    raw_color: str | None = None      # the customer's own words ("black", "أسود")
    size: str | None = None
    raw_size: str | None = None
    time: str | None = None
    order_ref: str | None = None
    matches: list[CatalogItem] = field(default_factory=list)
    color_missing: bool = False       # asked colour exists on no matching product
    terms: str = ""                   # what the customer called the product (for "not found" replies)
    raw_texts: list[str] = field(default_factory=list)   # customer messages that built this order (-> rawText)
    max_price: Decimal | None = None  # budget ceiling the customer stated ("تحت 200 جنيه")
    over_budget: list[CatalogItem] = field(default_factory=list)   # products that matched but cost more than the ceiling


class Planner:
    def __init__(self, ctx: Ctx, min_confidence: float = 0.4):
        self.ctx = ctx
        self.lang: Language = ctx.language
        self.min_confidence = min_confidence

    # ------------------------------------------------------------------ small language helpers

    def T(self, key: str, **kw: object) -> str:
        return t(self.lang, key, **kw)

    def join(self, items: list[str]) -> str:
        return ("، " if self.lang == "ar" else ", ").join(items)

    def color_label(self, key: str | None) -> str:
        return COLOR_DISPLAY.get(key or "", key or "") if self.lang == "ar" else (key or "")

    # ------------------------------------------------------------------ entry point

    def plan(self, rr: RouterResult, confirming: bool = False) -> Plan:
        """Turn the Router's JSON into a verified draft reply (+ the E0-3 candidate once the customer confirmed)."""
        intent = rr.intents[0] if rr.intents else Intent.UNKNOWN
        secondary = [i for i in rr.intents[1:] if i != intent]
        confidence = max(0.0, min(1.0, float(rr.confidence)))
        if intent != Intent.UNKNOWN and confidence < self.min_confidence:
            intent, secondary = Intent.UNKNOWN, []

        slots = self._slots(rr, carry_over=(self.ctx.mid_order or confirming) and intent == Intent.CREATE_ORDER,
                            awaiting_confirm=self.ctx.awaiting_confirm, confirming=confirming)
        intent = self._faq_override(intent, slots, rr)
        plan = self._dispatch(intent, slots, rr, confirming, confidence)
        plan.secondary = secondary
        plan.confidence = round(confidence, 2)
        self._apply_owner_flags(plan, intent, rr)
        return plan

    def _faq_override(self, intent: Intent, s: Slots, rr: RouterResult) -> Intent:
        """Code has the last word: a question the owner answered in the FAQ is GENERAL_INFO, even if the Router called
        it a product/price question or gave up (UNKNOWN). Only when no catalog product was matched."""
        if intent not in (Intent.PRODUCT_INQUIRY, Intent.PRICE_INQUIRY, Intent.UNKNOWN) or s.matches or not self.ctx.faqs:
            return intent
        idx, score = match_faq(self.ctx.text, self.ctx.faqs)
        needed = WEAK_FAQ_SCORE if intent == Intent.UNKNOWN else STRONG_FAQ_SCORE
        if idx is None or score < needed:
            return intent
        rr.faq_id = idx + 1
        return Intent.GENERAL_INFO

    def _apply_owner_flags(self, plan: Plan, intent: Intent, rr: RouterResult) -> None:
        """requiresReview=true makes the backend show the message to the owner right away."""
        if intent in OWNER_REVIEW_INTENTS:
            plan.owner_review = True
        if self.ctx.is_angry_customer:
            plan.grounded = False   # careful mode: only the fixed, reviewed templates, never a creative rewrite
            if intent == Intent.COMPLAINT:
                plan.owner_review = True   # a complaint after a dispute / threat keeps escalating
        elif intent == Intent.COMPLAINT and rr.requires_review:
            plan.owner_review = True

    # ------------------------------------------------------------------ slots / product resolution

    def _slots(self, rr: RouterResult, carry_over: bool, awaiting_confirm: bool, confirming: bool = False) -> Slots:
        ctx = self.ctx
        safety = extract_entities(ctx.text)  # deterministic safety net next to the model
        s = Slots(quantity=rr.quantity if rr.quantity else safety.quantity,
                  color=norm_color(rr.color) or safety.color, size=norm_size(rr.size) or safety.size,
                  time=rr.preferred_time or safety.time_phrase, order_ref=rr.order_reference or safety.order_ref)
        s.raw_color = rr.color or safety.raw_color or (COLOR_DISPLAY.get(safety.color) if safety.color else None)
        s.raw_size = rr.size or safety.size
        s.terms = " ".join(tok.orig for tok in safety.product_tokens) or (rr.product_query or "")
        s.raw_texts = [ctx.text]
        cap = Decimal(str(rr.max_price)) if rr.max_price and rr.max_price > 0 else safety.max_price
        s.max_price = cap

        by_model = search_products(rr.product_query, ctx.products, cap) if rr.product_query else []
        by_text = find_products(safety.product_tokens, ctx.products, cap)
        # Gemini's product_query can be broader than what the customer wrote ("t-shirt" vs "cotton t-shirt"):
        # prefer products both views agree on, otherwise whichever view found something.
        agreed = [p for p in by_model if str(p.id) in {str(x.id) for x in by_text}]
        matches = agreed or by_model or by_text
        if cap is not None and not matches:   # what exists for that product, but above the budget
            s.over_budget = (search_products(rr.product_query, ctx.products, Decimal("1e9")) if rr.product_query else []) \
                or find_products(safety.product_tokens, ctx.products)

        if carry_over:
            # Continue the order in progress ("black L two", "yes confirm") but never leak the previous order's
            # colour/size/quantity into a NEW order for a different product.
            prevs = []
            for text in ctx.inbound_texts[-CARRY_OVER_MESSAGES:]:
                pe = extract_entities(text)
                prevs.append((text, pe, find_products(pe.product_tokens, ctx.products)))
            anchor = max((i for i, (_, _, pm) in enumerate(prevs) if pm), default=None)
            # a bare "yes" in any wording ("حاضر يا باشا") names nothing: only its words must not be read as a product
            unknown_term = bool(safety.product_tokens) and not matches and not confirming
            proceed = anchor is not None and not unknown_term
            if proceed and matches:
                overlap = {str(p.id) for p in prevs[anchor][2]} & {str(p.id) for p in matches}
                proceed = bool(overlap) and not awaiting_confirm
            if proceed:
                for text, pe, _ in reversed(prevs[anchor:]):
                    s.quantity = s.quantity or pe.quantity
                    if not s.color and pe.color:
                        s.color, s.raw_color = pe.color, pe.raw_color or COLOR_DISPLAY.get(pe.color)
                    if not s.size and pe.size:
                        s.size = s.raw_size = pe.size
                    s.time = s.time or pe.time_phrase
                    s.raw_texts.insert(0, text)
                if not matches:
                    matches = prevs[anchor][2]
                    s.terms = " ".join(tok.orig for tok in prevs[anchor][1].product_tokens)

        if cap is not None:
            matches = [p for p in matches if within_budget(p, cap)]   # carried-over products obey the budget too
        if s.color and matches:
            colored = [p for p in matches if has_color(p, s.color)]
            if colored:
                matches = colored
            elif any(product_colors(p) for p in matches):
                s.color_missing = True  # the catalog defines colours and none matches; no colours defined -> pass-through
        s.matches = matches
        return s

    # ------------------------------------------------------------------ dispatch

    def _dispatch(self, intent: Intent, s: Slots, rr: RouterResult, confirming: bool, confidence: float) -> Plan:
        norm = normalize(self.ctx.text)
        if intent == Intent.GREETING:
            key = "GREETING_SALAM" if self.lang == "ar" and re.search(r"سلام\s+عليكم", norm) else "GREETING"
            return Plan(intent, self.T(key))
        if intent == Intent.THANKYOU:
            return Plan(intent, self.T("THANKYOU"))
        if intent == Intent.UNKNOWN:
            return Plan(intent, self.T("UNKNOWN"))
        if intent == Intent.PRODUCT_INQUIRY:
            reply, names = self._product_inquiry(s)
            return Plan(intent, reply, grounded=True, protected_terms=names)
        if intent == Intent.PRICE_INQUIRY:
            reply, names = self._price_inquiry(s)
            return Plan(intent, reply, grounded=True, protected_terms=names)
        if intent == Intent.GENERAL_INFO:   # owner-written / stored facts (FAQ, hours, delivery, payment): sent VERBATIM
            return Plan(intent, self._general_info(rr, norm))
        if intent == Intent.ORDER_STATUS:
            return Plan(intent, self._follow_up(s, norm), grounded=True)
        if intent == Intent.RETURNS_POLICY:
            return Plan(intent, self._general_info(rr, norm, topic=FaqTopic.RETURNS))   # verbatim, never rephrased
        if intent == Intent.COMPLAINT:
            return Plan(intent, self._complaint(s, norm))
        if intent == Intent.HELP:
            return Plan(intent, self.T("HELP"))   # a fixed explanation of how ordering works
        if intent in (Intent.ORDER_CANCEL, Intent.ORDER_MODIFY):
            return self._order_change(intent, s, confirming)
        if intent in OWNER_REVIEW_INTENTS:        # PAYMENT_DISPUTE / LEGAL_THREAT / CUSTOM_REQUEST: fixed, careful wording
            return Plan(intent, self.T(intent.value), owner_review=True)
        return self._create_order(s, confirming, confidence)

    # ------------------------------------------------------------------ catalog helpers

    def _categories_text(self) -> str:
        seen: dict[str, None] = {}
        for p in self.ctx.products:
            if p.category:
                seen.setdefault(p.category)
        return self.T("CATEGORIES", items=self.join(list(seen))) if seen else self.T("UNKNOWN")

    def _line(self, p: CatalogItem) -> str:
        price = fmt_money(p.basePrice)
        if price is None:
            return self.T("LINE_NO_PRICE", name=p.name)
        if p.trackInventory and p.stockQuantity is not None and 0 < p.stockQuantity <= LOW_STOCK_THRESHOLD:
            return self.T("LINE_LOW", name=p.name, price=price, left=p.stockQuantity)
        return self.T("LINE", name=p.name, price=price)

    def _options_lines(self, p: CatalogItem) -> list[str]:
        lines = []
        if colors_are_a_choice(p):
            lines.append(self.T("OPTIONS_COLORS", items=self.join(product_colors(p))))
        if sizes_are_a_choice(p):
            lines.append(self.T("OPTIONS_SIZES", items=self.join(product_sizes(p))))
        return lines

    def _alternatives(self, p: CatalogItem) -> list[CatalogItem]:
        return [o for o in self.ctx.products if str(o.id) != str(p.id) and o.category == p.category and in_stock(o)][:3]

    # ------------------------------------------------------------------ PRODUCT / PRICE

    def _budget_reply(self, s: Slots) -> tuple[str, list[str]] | None:
        """Answer a "under X EGP" question. None = not a budget question, or the normal product answer applies."""
        cap = s.max_price
        if cap is None or s.matches:
            return None
        shown = fmt_money(cap)
        if s.over_budget:   # the product exists, but everything costs more than the customer wants to pay
            priced = [p for p in s.over_budget if p.basePrice is not None]
            if priced:
                cheapest = min(priced, key=lambda p: p.basePrice)
                return (self.T("NONE_UNDER_BUDGET", term=s.terms or cheapest.name, max=shown, name=cheapest.name,
                               price=fmt_money(cheapest.basePrice)), [cheapest.name])
        if not s.terms:     # no product named: "عندكم حاجة تحت 200؟" -> everything under the ceiling, cheapest first
            items = budget_products(self.ctx.products, cap, MAX_LIST)
            if items:
                lines = "\n".join(self._line(p) for p in items)
                return self.T("UNDER_BUDGET", max=shown, lines=lines) + "\n" + self.T("PICK_ONE"), [p.name for p in items]
            return self.T("NONE_UNDER_BUDGET_ANY", max=shown), []
        return None

    def _product_inquiry(self, s: Slots) -> tuple[str, list[str]]:
        budget = self._budget_reply(s)
        if budget:
            return budget
        matches = s.matches
        if not matches:
            if s.terms:
                return self.T("NOT_FOUND", term=s.terms, categories=self._categories_text()), []
            return self._categories_text(), []
        if s.color_missing:
            colors: list[str] = []
            for p in matches:
                colors += [c for c in product_colors(p) if c not in colors]
            name = matches[0].name if len(matches) == 1 else (s.terms or matches[0].name)
            reply = self.T("NO_COLOR", name=name, color=s.raw_color or self.color_label(s.color))
            if colors:
                reply += "\n" + self.T("COLORS_AVAILABLE", items=self.join(colors))
            return reply, [p.name for p in matches[:MAX_LIST]]
        available = [p for p in matches if in_stock(p)]
        sold_out = [p for p in matches if not in_stock(p)]
        if not available:
            reply = self.T("SOLD_OUT", name=self.join([p.name for p in sold_out]))
            alts = self._alternatives(sold_out[0])
            if alts:
                reply += "\n" + self.T("ALTERNATIVES", lines="\n".join(self._line(a) for a in alts))
            return reply, [p.name for p in sold_out + alts]
        if len(available) == 1:
            p = available[0]
            price = fmt_money(p.basePrice)
            first = self.T("ONE_PRODUCT", name=p.name, price=price) if price else self.T("LINE_NO_PRICE", name=p.name) + "."
            if p.trackInventory and p.stockQuantity is not None and 0 < p.stockQuantity <= LOW_STOCK_THRESHOLD:
                first = first.rstrip(".") + (f"، باقي {p.stockQuantity} بس." if self.lang == "ar"
                                              else f", only {p.stockQuantity} left.")
            parts = [first] + self._options_lines(p)
            if s.size and sizes_are_a_choice(p) and s.size not in {norm_size(x) for x in product_sizes(p)}:
                parts.append(self.T("SIZE_NA", size=s.size))
            if sold_out:
                parts.append(self.T("SOLD_OUT_PLUS", name=self.join([o.name for o in sold_out])))
            if not self.ctx.is_angry_customer:   # no sales push on an upset customer
                parts.append(self.T("ASK_ORDER"))
            return "\n".join(parts), [p.name] + [o.name for o in sold_out]
        reply = self.T("MANY_PRODUCTS", lines="\n".join(self._line(p) for p in available[:MAX_LIST]))
        if sold_out:
            reply += "\n" + self.T("SOLD_OUT_PLUS", name=self.join([p.name for p in sold_out]))
        return reply + "\n" + self.T("PICK_ONE"), [p.name for p in available[:MAX_LIST] + sold_out]

    def _price_inquiry(self, s: Slots) -> tuple[str, list[str]]:
        budget = self._budget_reply(s)
        if budget:
            return budget
        if not s.matches:
            if s.terms:
                return self.T("NOT_FOUND", term=s.terms, categories=self._categories_text()), []
            return self.T("PRICE_ASK"), []

        def one(p: CatalogItem) -> str:
            price = fmt_money(p.basePrice)
            return self.T("PRICE_ONE", name=p.name, price=price) if price else self.T("PRICE_NO_PRICE", name=p.name)

        shown = s.matches[:MAX_LIST]
        return "\n".join(one(p) for p in shown), [p.name for p in shown]

    # ------------------------------------------------------------------ CREATE_ORDER

    def _create_order(self, s: Slots, confirming: bool, confidence: float) -> Plan:
        intent = Intent.CREATE_ORDER

        def say(text: str, names: list[str] | None = None, **kw) -> Plan:
            return Plan(intent, text, grounded=True, protected_terms=names or [], **kw)

        def ask(text: str, names: list[str] | None = None) -> Plan:
            return Plan(intent, text, grounded=True, clarification=True, protected_terms=names or [])

        matches = s.matches
        if not matches:
            budget = self._budget_reply(s)
            if budget:
                return say(budget[0], budget[1])
            if s.terms:
                return say(self.T("NOT_FOUND", term=s.terms, categories=self._categories_text()))
            return ask(self.T("ASK_PRODUCT"))

        stocked = [p for p in matches if in_stock(p)]
        if not stocked:
            text = self.T("SOLD_OUT", name=self.join([p.name for p in matches]))
            alts = self._alternatives(matches[0])
            if alts:
                text += "\n" + self.T("ALTERNATIVES", lines="\n".join(self._line(a) for a in alts))
            return say(text, [p.name for p in matches + alts])
        if len(stocked) > 1:
            shown = stocked[:MAX_LIST]
            return ask(self.T("ASK_WHICH", lines="\n".join(self._line(p) for p in shown)), [p.name for p in shown])

        p = stocked[0]
        service = is_service_item(p)
        colors, sizes = product_colors(p), product_sizes(p)
        color_choice, size_choice = colors_are_a_choice(p), sizes_are_a_choice(p)

        # a bare number that is not a size of this product is a quantity ("40 caps")
        if s.size and s.size.isdigit() and not sizes and not s.quantity:
            s.quantity, s.size, s.raw_size = int(s.size), None, None

        selected: dict[str, str] = {}
        reasons: list[ReviewReason] = []
        invalid: list[str] = []
        missing: list[str] = []
        passthrough: list[str] = []

        # ---- colour policy. Catalog defines colours: validate. Catalog defines none: keep what the customer said.
        if colors:
            if s.color:
                match = next((c for c in colors if norm_color(c) == s.color), None)
                if match:
                    selected["color"] = match
                elif color_choice:
                    invalid.append(self.T("INVALID_COLOR", color=s.raw_color or self.color_label(s.color)))
                else:  # the only colour that exists is another one: never silently order a different colour
                    reply = (self.T("NO_COLOR", name=p.name, color=s.raw_color or self.color_label(s.color)) + "\n"
                             + self.T("COLORS_AVAILABLE", items=self.join(colors)))
                    return say(reply, [p.name])
            elif color_choice:
                missing.append("color")
            else:
                selected["color"] = colors[0]
        elif s.color:
            selected["color"] = s.raw_color or self.color_label(s.color)
            passthrough.append("color")

        # ---- size policy (same idea)
        if sizes:
            if s.size:
                match = next((x for x in sizes if norm_size(x) == s.size), None)
                if match:
                    selected["size"] = match
                elif size_choice:
                    invalid.append(self.T("INVALID_SIZE", size=s.raw_size or s.size))
                else:
                    return say(self.T("SIZE_NA", size=s.raw_size or s.size) + "\n"
                               + self.T("OPTIONS_SIZES", items=self.join(sizes)), [p.name])
            elif size_choice:
                missing.append("size")
            else:
                selected["size"] = sizes[0]
        elif s.size:
            selected["size"] = s.raw_size or s.size
            passthrough.append("size")

        invalid_missing = [k for k, v in (("color", color_choice), ("size", size_choice)) if v and k not in selected
                           and k not in missing]
        missing += [k for k in invalid_missing if k not in missing]

        quantity = s.quantity if (s.quantity and s.quantity > 0) else (1 if service else None)
        if quantity is not None and quantity > MAX_QUANTITY:
            return ask(self.T("QTY_TOO_LARGE"), [p.name])
        if quantity is None:
            missing.append("quantity")
        if service and not s.time:
            missing.append("time")

        if missing:
            return ask(self._question(p, missing, invalid, colors, sizes), [p.name])

        assert quantity is not None
        if p.trackInventory and p.stockQuantity is not None and quantity > p.stockQuantity:
            return say(self.T("NOT_ENOUGH", name=p.name, left=p.stockQuantity), [p.name])

        color_in_name = "color" in selected and selected["color"].casefold() in p.name.casefold()
        desc = " ".join([p.name] + ([selected["color"]] if "color" in selected and not color_in_name else [])
                        + ([("مقاس " if self.lang == "ar" else "size ") + selected["size"]] if "size" in selected else []))
        unit = p.basePrice
        total = unit * quantity if unit is not None else None

        if not confirming:
            if service:
                text = self.T("BOOKING_SUMMARY", desc=desc, time=s.time, total=fmt_money(total) or "-")
            elif total is None:
                text = self.T("ORDER_SUMMARY_NO_TOTAL", desc=desc, qty=quantity)
            else:
                text = self.T("ORDER_SUMMARY", desc=desc, qty=quantity, total=fmt_money(total))
            if passthrough:
                what = self.T("WHAT_BOTH" if len(passthrough) == 2 else
                              "WHAT_COLOR" if passthrough == ["color"] else "WHAT_SIZE")
                note = self.T("PASSTHROUGH_NOTE", what=what)
                head, _, question = text.rpartition("\n")
                text = f"{head}\n{note}\n{question}"
            return Plan(intent, text, grounded=True, awaiting_confirmation=True, protected_terms=[p.name])

        # ---- the customer confirmed: build the E0-3 candidate (no prices, totals, stock or status, ever)
        item_conf = min(0.97, max(confidence, 0.0) or 0.85)
        if passthrough:
            reasons.append(ReviewReason.VARIANT_UNCLEAR)
            item_conf = min(item_conf, 0.6)
        catalog_id = _as_uuid(p.id)
        if catalog_id is None:
            reasons.append(ReviewReason.UNMATCHED_ITEM)
            item_conf = min(item_conf, 0.4)
        if p.trackInventory and p.stockQuantity is not None and quantity == p.stockQuantity:
            reasons.append(ReviewReason.OUT_OF_STOCK_RISK)
        texts = s.raw_texts[:-1] if confirming and len(s.raw_texts) > 1 else s.raw_texts   # drop the bare "yes"
        raw_text = " | ".join(texts)[:300] or self.ctx.text[:300]
        candidate = OrderCandidate(
            sourceMessageId=self.ctx.message_id,
            confidence=round(item_conf, 2),
            reviewReasons=list(dict.fromkeys(reasons)),
            notes=None,
            items=[OrderCandidateItem(
                catalogItemId=catalog_id, variantId=None, rawText=raw_text, quantity=quantity,
                selectedAttributes=selected, notes=(s.time[:500] if service and s.time else None),
                confidence=round(item_conf, 2))],
        )
        key = "BOOKING_CONFIRMED" if service else "ORDER_CONFIRMED"
        text = self.T(key, desc=desc, qty=quantity, time=s.time)
        return Plan(intent, text, grounded=True, candidate=candidate, review_reasons=candidate.reviewReasons,
                    protected_terms=[p.name])

    def _question(self, p: CatalogItem, missing: list[str], invalid: list[str], colors: list[str],
                  sizes: list[str]) -> str:
        if "time" in missing:
            return self.T("ASK_TIME", name=p.name)
        attrs = [k for k in ("color", "size") if k in missing]
        qty = "quantity" in missing
        if attrs == ["color", "size"]:
            what = self.T("ASK_COLOR_SIZE" if qty else "ASK_COLOR_SIZE_ONLY")
        elif attrs == ["color"]:
            what = self.T("ASK_COLOR_QTY") if qty else self.T("ASK_COLOR")
        elif attrs == ["size"]:
            what = self.T("ASK_SIZE_QTY") if qty else self.T("ASK_SIZE")
        else:
            what = self.T("ASK_QTY")
        text = (self.T("ASK_SLOTS_INVALID", invalid=" ".join(invalid), what=what) if invalid
                else self.T("ASK_SLOTS", name=p.name, what=what))
        opts = []
        if "color" in attrs:
            opts.append(self.T("OPTIONS_COLORS", items=self.join(colors)))
        if "size" in attrs:
            opts.append(self.T("OPTIONS_SIZES", items=self.join(sizes)))
        return "\n".join([text] + opts)

    # ------------------------------------------------------------------ FOLLOW_UP / COMPLAINT

    def _status(self, status: str) -> str:
        return STATUS[self.lang].get(status, status)

    @staticmethod
    def _label(order) -> str:
        names = [i.name for i in order.items[:2]]
        return ", ".join(names) + ("…" if len(order.items) > 2 else "")

    def _orders(self, ref: str | None):
        orders = sorted(self.ctx.orders, key=lambda o: o.createdAt or "", reverse=True)
        by_ref = [o for o in orders if ref and re.sub(r"\D", "", str(o.orderNumber)) == ref]
        return orders, by_ref

    def _follow_up(self, s: Slots, norm: str = "") -> str:
        """ORDER_STATUS: report the status of the customer's order(s) exactly as the backend sent it."""
        if not self.ctx.orders_provided:
            return self.T("FOLLOW_UNSUPPORTED")
        orders, by_ref = self._orders(s.order_ref)
        eta_asked = bool(re.search(r"امتي|موعد|هيوصل|when|arrive|eta", norm))

        def one(o) -> str:
            text = self.T("FOLLOW_ONE", number=o.orderNumber, items=self._label(o), status=self._status(o.status))
            if eta_asked and o.status in ACTIVE_STATUSES:   # we know the status, never a delivery time
                text += " " + self.T("FOLLOW_ETA_NOTE")
            return text

        if s.order_ref:
            return one(by_ref[0]) if by_ref else self.T("FOLLOW_REF_NOT_FOUND", ref=s.order_ref)
        active = self.ctx.active_orders
        if len(active) == 1:
            return one(active[0])
        if len(active) > 1:
            lines = "\n".join(f"#{o.orderNumber}: {self._status(o.status)}" for o in active[:MAX_LIST])
            return self.T("FOLLOW_MANY", lines=lines)
        return one(orders[0]) if orders else self.T("FOLLOW_NONE")

    def _order_change(self, intent: Intent, s: Slots, confirming: bool) -> Plan:
        """ORDER_CANCEL / ORDER_MODIFY. The AI cannot change orders: it asks the customer to confirm, then states that the
        owner must confirm it (requiresReview=true). No promise, no claim that anything was cancelled or changed."""
        ctx = self.ctx
        prefix = "CANCEL" if intent == Intent.ORDER_CANCEL else "MODIFY"
        if confirming:   # the customer just answered "yes" to our confirmation question
            number = s.order_ref or ctx.pending_order_ref
            key = f"{prefix}_DONE" if number else f"{prefix}_DONE_NONUM"
            return Plan(intent, self.T(key, number=number), owner_review=True)

        target = None
        if ctx.orders_provided:
            orders, by_ref = self._orders(s.order_ref)
            if s.order_ref:
                if not by_ref:
                    return Plan(intent, self.T("FOLLOW_REF_NOT_FOUND", ref=s.order_ref))
                target = by_ref[0]
            else:
                active = ctx.active_orders
                if not active:
                    return Plan(intent, self.T("NO_ACTIVE_ORDER"))
                if len(active) > 1:
                    lines = "\n".join(f"#{o.orderNumber}: {self._label(o)}" for o in active[:MAX_LIST])
                    return Plan(intent, self.T("ASK_WHICH_ORDER", lines=lines), clarification=True)
                target = active[0]
            if target.status not in ACTIVE_STATUSES:   # already delivered / cancelled: just say where it stands
                return Plan(intent, self.T("FOLLOW_ONE", number=target.orderNumber, items=self._label(target),
                                           status=self._status(target.status)))
        number = target.orderNumber if target else s.order_ref
        if number:
            items = self._label(target) if target else ""
            return Plan(intent, self.T(f"{prefix}_ASK", number=number, items=items))
        return Plan(intent, self.T(f"{prefix}_ASK_NONUM"))

    def _complaint(self, s: Slots, norm: str) -> str:
        delayed = bool(re.search(r"تاخر|متاخر|لسه|مجاش|late|delay|still not", norm))
        orders, by_ref = self._orders(s.order_ref)
        target = by_ref[0] if by_ref else None
        if target is None:
            active = [o for o in orders if o.status in ACTIVE_STATUSES]
            target = active[0] if len(active) == 1 else None
        if target is not None:
            return self.T("COMPLAINT_DELAY_KNOWN" if delayed else "COMPLAINT_KNOWN", number=target.orderNumber,
                          status=self._status(target.status))
        return self.T("COMPLAINT" if delayed else "COMPLAINT_GENERIC")

    # ------------------------------------------------------------------ GENERAL_INFO (business data)

    def _time_text(self, hhmm: str) -> str:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", (hhmm or "").strip())
        if not m:
            return hhmm
        h, minute = int(m.group(1)), int(m.group(2))
        h12 = h % 12 or 12
        if self.lang == "en":
            return f"{h12}:{minute:02d} {'AM' if h < 12 else 'PM'}"
        word = ("بالليل" if h == 0 else "بعد نص الليل" if h < 5 else "الصبح" if h < 12 else "الضهر" if h < 17
                else "العصر" if h < 19 else "بالليل")
        return f"{h12}{f':{minute:02d}' if minute else ''} {word}"

    def _days_text(self, days: list[str]) -> str:
        names = DAYS[self.lang]
        if len(days) == 1:
            return names[days[0]]
        a, b = names[days[0]], names[days[-1]]
        if self.lang == "ar":
            b = ("لل" + b[2:]) if b.startswith("ال") else "ل" + b
        return self.T("H_FROM_TO_DAYS", a=a, b=b)

    def hours_text(self) -> str | None:
        """Working-hours rows (as the backend stores them) -> one natural sentence."""
        by_day = {h.dayOfWeek: h for h in self.ctx.business.workingHours}
        state: dict[str, tuple] = {}
        for day in WEEK_ORDER:
            h = by_day.get(day)
            if h is None:
                continue
            state[day] = ("open", h.opensAt, h.closesAt) if (h.isOpen and h.opensAt and h.closesAt) else (
                ("closed",) if not h.isOpen else ("unknown",))
        groups: list[tuple[tuple, list[str]]] = []
        for day in WEEK_ORDER:
            if day not in state:
                continue
            idx = WEEK_ORDER.index(day)
            if groups and groups[-1][0] == state[day] and WEEK_ORDER.index(groups[-1][1][-1]) == idx - 1:
                groups[-1][1].append(day)
            else:
                groups.append((state[day], [day]))
        parts = []
        for st, days in groups:
            if st[0] == "open":
                parts.append(f"{self._days_text(days)} " + self.T("H_TIME", a=self._time_text(st[1]), b=self._time_text(st[2])))
            elif st[0] == "closed":
                parts.append(self.T("H_CLOSED", day=self._days_text(days)))
        if not parts:
            return None
        if self.lang == "ar":
            body = parts[0] + "".join("، و" + p for p in parts[1:])
        else:
            body = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + ", and " + parts[-1]
        return self.T("HOURS", parts=body)

    def _delivery(self) -> str:
        policy = self.ctx.knowledge.policies.get("delivery")
        if policy:
            return policy
        st = self.ctx.business.settings
        if not st.deliveryEnabled:
            return self.T("DELIVERY_NO" if st.pickupEnabled else "DELIVERY_NO_NOPICKUP")
        return self.T("DELIVERY_YES")

    def _payment(self) -> str:
        policy = self.ctx.knowledge.policies.get("payment")
        if policy:
            return policy
        st = self.ctx.business.settings
        if st.acceptsCash and st.acceptsOnlinePayment:
            return self.T("PAY_BOTH")
        return self.T("PAY_CASH") if st.acceptsCash else self.T("PAY_ONLINE") if st.acceptsOnlinePayment else self.T("PAY_NONE")

    def _faq_answer(self, number: int | None) -> str | None:
        """Answer of FAQ #number (1-based, same numbering as the Router prompt), if that number exists."""
        if number is not None and 1 <= number <= len(self.ctx.faqs):
            return str(self.ctx.faqs[number - 1]["answer"]).strip()
        return None

    def _general_info(self, rr: RouterResult, norm: str, topic: FaqTopic | None = None) -> str:
        """Owner-written FAQ first (it is the most specific), then the structured business data, else "no confirmed info"."""
        ctx, b = self.ctx, self.ctx.business
        picked = self._faq_answer(rr.faq_id)
        idx, score = match_faq(ctx.text, ctx.faqs)
        if picked:
            return picked
        if idx is not None and score >= STRONG_FAQ_SCORE:
            return self._faq_answer(idx + 1) or self.T("FAQ_UNKNOWN")

        topic = topic or rr.faq_topic or detect_faq_topic(norm)
        answer: str | None = None
        if topic == FaqTopic.DELIVERY:
            answer = self._delivery()
        elif topic == FaqTopic.WORKING_HOURS:
            answer = self.hours_text() or self.T("HOURS_NONE")
        elif topic == FaqTopic.PAYMENT:
            answer = self._payment()
        elif topic == FaqTopic.RETURNS:
            answer = ctx.knowledge.policies.get("returns")
        elif topic == FaqTopic.LOCATION:
            answer = ctx.knowledge.policies.get("location") or (
                self.T("ADDRESS", address=b.address) if b.address else self.T("ADDRESS_NONE"))
        elif topic == FaqTopic.CONTACT:
            answer = self.T("PHONE", phone=b.phone) if b.phone else self.T("PHONE_NONE")
        if answer:
            return answer
        if idx is not None and score >= WEAK_FAQ_SCORE:
            return self._faq_answer(idx + 1) or self.T("FAQ_UNKNOWN")
        return self.T("FAQ_UNKNOWN")
