"""Turns the raw request into the single object every pipeline stage reads.

This is also where the strict safety filters live: anything that must never reach the LLM (inactive products,
empty rows) is removed here, once, before the Router or the Generator can see it.

It also derives the conversation state the later stages depend on (all from the messages and orders the backend sent,
nothing is remembered between requests):

* ``awaiting_confirm`` / ``mid_order``    our last message was an order summary / asked for an order detail,
* ``pending_action``                      our last message asked to confirm cancelling or changing an existing order,
* ``has_active_orders`` / ``active_orders`` what the customer has in progress (for "طلبي وصل فين؟"),
* ``is_angry_customer``                   a payment dispute or a legal threat in the recent messages,
* ``faqs``                                the owner-written FAQs, numbered exactly like in the Router prompt.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from ..nlu import detect_language, is_hostile_text, normalize
from ..prompts.templates import (CANCEL_CONFIRM_MARKERS, CLARIFICATION_MARKERS, CONFIRM_MARKERS,
                                 MODIFY_CONFIRM_MARKERS)
from ..schemas import (AIRespondRequest, BusinessIn, BusinessKnowledge, CatalogItem, CustomerOrder, Language)

HISTORY_LIMIT = 12
MAX_FAQS = 40                      # the Router prompt and the planner must number the FAQs identically
ANGER_LOOKBACK = 3                 # how many earlier customer messages keep the "careful" mode switched on
ACTIVE_ORDER_STATUSES = frozenset({"PENDING", "PENDING_APPROVAL", "IN_PROGRESS"})

PendingAction = Literal["cancel", "modify"]
_ORDER_NUMBER = re.compile(r"(?:رقم|#|order\s*#?)\s*(\d{3,6})", re.IGNORECASE)


@dataclass
class Turn:
    """One earlier message of the conversation."""

    direction: str   # "INBOUND" (customer) | "OUTBOUND" (AI or owner)
    text: str


@dataclass
class Ctx:
    """Everything a pipeline stage may read about this request. Built once by :func:`build_context`."""

    text: str
    message_id: UUID
    business: BusinessIn
    knowledge: BusinessKnowledge
    products: list[CatalogItem]          # ACTIVE products only. The only catalog the LLM ever sees.
    history: list[Turn]                  # chronological, without the current message
    language: Language
    awaiting_confirm: bool               # our last message was the order summary asking for confirmation
    mid_order: bool                      # our last message asked the customer for an order detail
    orders: list[CustomerOrder] = field(default_factory=list)
    orders_provided: bool = False        # the backend sent `customerOrders` at all (even an empty list)
    dropped_inactive: int = 0
    pending_action: PendingAction | None = None    # we asked to confirm cancelling / changing an existing order
    pending_order_ref: str | None = None           # the order number our last message mentioned, if any
    is_angry_customer: bool = False                # payment dispute / legal threat now or just before
    faqs: list[dict[str, Any]] = field(default_factory=list)

    @property
    def inbound_texts(self) -> list[str]:
        return [t.text for t in self.history if t.direction == "INBOUND"]

    @property
    def active_orders(self) -> list[CustomerOrder]:
        """Orders still in progress, newest first."""
        live = [o for o in self.orders if o.status in ACTIVE_ORDER_STATUSES]
        return sorted(live, key=lambda o: o.createdAt or "", reverse=True)

    @property
    def has_active_orders(self) -> bool:
        """True when the customer has at least one order in progress (pending, awaiting approval or being prepared)."""
        return any(o.status in ACTIVE_ORDER_STATUSES for o in self.orders)


def _chronological(request: AIRespondRequest) -> list:
    """Text messages in time order. The messages API returns newest first, so sort by ``createdAt`` when we can."""
    msgs = [m for m in request.conversation if (m.content or "").strip() and m.messageType.upper() == "TEXT"]
    if msgs and all(m.createdAt for m in msgs):
        msgs = sorted(msgs, key=lambda m: m.createdAt or "")   # ISO-8601 sorts lexicographically
    return msgs


def _contains_marker(text_norm: str, markers: tuple[str, ...]) -> bool:
    return any(normalize(m) in text_norm for m in markers)


def _faq_list(request: AIRespondRequest) -> list[dict[str, Any]]:
    """Owner FAQs that have both a question and an answer, capped, in the order the Router prompt numbers them."""
    usable = [f for f in request.businessKnowledge.faqs
              if f.get("isActive") is not False                      # a soft-deleted FAQ row must never be answered
              and str(f.get("question") or "").strip() and str(f.get("answer") or "").strip()]
    return usable[:MAX_FAQS]


def build_context(request: AIRespondRequest) -> Ctx:
    """Normalise the request into a :class:`Ctx` (strict ``isActive`` filter, language, conversation state)."""
    text = request.text

    # STRICT FILTER: an inactive (soft-deleted) product must never be offered, priced or sold, so it is removed before
    # any prompt is built. Items without a name are dropped too.
    active = [p for p in request.catalog if p.isActive is True and p.name.strip()]
    dropped = len(request.catalog) - len(active)

    msgs = _chronological(request)
    # the backend stores the customer's message before calling us, so it usually appears last in `conversation`
    if msgs and msgs[-1].senderType == "CUSTOMER" and (
            (msgs[-1].id is not None and str(msgs[-1].id) == str(request.messageId))
            or normalize(msgs[-1].content or "") == normalize(text)):
        msgs = msgs[:-1]
    history = [Turn("INBOUND" if m.senderType == "CUSTOMER" else "OUTBOUND", (m.content or "").strip())
               for m in msgs][-HISTORY_LIMIT:]

    last_out = next((t.text for t in reversed(history) if t.direction == "OUTBOUND"), "")
    last_out_norm = normalize(last_out)
    mid_order = _contains_marker(last_out_norm, CLARIFICATION_MARKERS)
    awaiting_confirm = _contains_marker(last_out_norm, CONFIRM_MARKERS)

    pending_action: PendingAction | None = None
    if _contains_marker(last_out_norm, CANCEL_CONFIRM_MARKERS):
        pending_action = "cancel"
    elif _contains_marker(last_out_norm, MODIFY_CONFIRM_MARKERS):
        pending_action = "modify"
    ref = _ORDER_NUMBER.search(last_out) if pending_action else None

    inbound = [t.text for t in history if t.direction == "INBOUND"]
    previous_customer = inbound[-1] if inbound else ""
    language = detect_language(text, fallback=detect_language(previous_customer, fallback="ar"))

    # "careful mode": a payment dispute / legal threat in this message or in the last few customer messages
    angry = is_hostile_text(text) or any(is_hostile_text(m) for m in inbound[-ANGER_LOOKBACK:])

    return Ctx(
        text=text, message_id=request.messageId, business=request.business, knowledge=request.businessKnowledge,
        products=active, history=history, language=language, awaiting_confirm=awaiting_confirm, mid_order=mid_order,
        orders=list(request.customerOrders), orders_provided="customerOrders" in request.model_fields_set,
        dropped_inactive=dropped, pending_action=pending_action, pending_order_ref=ref.group(1) if ref else None,
        is_angry_customer=angry, faqs=_faq_list(request),
    )
