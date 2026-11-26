"""Internal (not part of the HTTP contract): the Router's structured output and the planner's decision."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .response import E03Intent, OrderCandidate, ReviewReason

Language = Literal["ar", "en"]


class Intent(str, Enum):
    """Fine-grained intents used internally; mapped to the four E0-3 intents on the way out."""

    PRODUCT_INQUIRY = "PRODUCT_INQUIRY"
    PRICE_INQUIRY = "PRICE_INQUIRY"
    CREATE_ORDER = "CREATE_ORDER"
    GENERAL_INFO = "GENERAL_INFO"
    ORDER_STATUS = "ORDER_STATUS"          # "طلبي وصل فين؟" (was FOLLOW_UP)
    GREETING = "GREETING"
    THANKYOU = "THANKYOU"
    COMPLAINT = "COMPLAINT"
    UNKNOWN = "UNKNOWN"
    # customer-service intents
    HELP = "HELP"                          # "إزاي أطلب؟" "إزاي أستخدم البوت؟"
    ORDER_MODIFY = "ORDER_MODIFY"          # "عايز أغير العنوان"
    ORDER_CANCEL = "ORDER_CANCEL"          # "عايز ألغي الأوردر"
    RETURNS_POLICY = "RETURNS_POLICY"      # "إزاي أرجع المنتج؟"
    PAYMENT_DISPUTE = "PAYMENT_DISPUTE"    # "أنا دفعت ومحدش رد"          -> owner review
    LEGAL_THREAT = "LEGAL_THREAT"          # "هشتكي عليكم"                -> owner review
    CUSTOM_REQUEST = "CUSTOM_REQUEST"      # "عايز تصميم خاص"             -> owner review

    @classmethod
    def _missing_(cls, value: object) -> "Intent | None":
        """Accept the legacy wire value "FOLLOW_UP" (old clients / cached router outputs)."""
        return cls.ORDER_STATUS if value == "FOLLOW_UP" else None


# DEPRECATED alias for old code/tests: Intent.FOLLOW_UP is Intent.ORDER_STATUS. It is a plain class attribute (not an Enum
# alias member), so it never appears in iteration or in the JSON schema sent to Gemini.
Intent.FOLLOW_UP = Intent.ORDER_STATUS  # type: ignore[attr-defined]

# Intents the owner must see immediately: the response carries requiresReview=true.
OWNER_REVIEW_INTENTS = frozenset({Intent.PAYMENT_DISPUTE, Intent.LEGAL_THREAT, Intent.CUSTOM_REQUEST})


class FaqTopic(str, Enum):
    DELIVERY = "DELIVERY"
    WORKING_HOURS = "WORKING_HOURS"
    PAYMENT = "PAYMENT"
    RETURNS = "RETURNS"
    LOCATION = "LOCATION"
    CONTACT = "CONTACT"
    OTHER = "OTHER"


class Confirmation(str, Enum):
    YES = "YES"
    NO = "NO"


class RouterResult(BaseModel):
    """Strict JSON the Router returns (also used as Gemini's response_schema)."""

    model_config = ConfigDict(extra="ignore")

    intents: list[Intent] = Field(description="Primary intent first, then secondary ones (max 3).")
    confidence: float = Field(description="0..1, how sure you are about the primary intent")
    product_query: str | None = None
    quantity: int | None = None
    color: str | None = None
    size: str | None = None
    preferred_time: str | None = None
    order_reference: str | None = None
    faq_topic: FaqTopic | None = None
    faq_id: int | None = Field(
        default=None, description="1-based number of the matching entry in the business FAQ list given in the prompt.")
    max_price: float | None = Field(
        default=None, description="Budget ceiling in EGP when the customer says 'under 200' / 'cheaper than 500'.")
    requires_review: bool | None = Field(
        default=None, description="true for PAYMENT_DISPUTE, LEGAL_THREAT and CUSTOM_REQUEST (owner must see it).")
    confirmation: Confirmation | None = Field(
        default=None, description="YES/NO only if the store's last message asked the customer to confirm an order, a cancellation or a change.")


INTENT_TO_E03 = {
    Intent.PRODUCT_INQUIRY: E03Intent.INQUIRY,
    Intent.PRICE_INQUIRY: E03Intent.INQUIRY,
    Intent.GENERAL_INFO: E03Intent.INQUIRY,
    Intent.ORDER_STATUS: E03Intent.INQUIRY,
    Intent.HELP: E03Intent.INQUIRY,
    Intent.RETURNS_POLICY: E03Intent.INQUIRY,
    Intent.CREATE_ORDER: E03Intent.PURCHASE_INTENT,   # becomes CONFIRMED_ORDER only on explicit customer confirmation
    Intent.GREETING: E03Intent.OTHER,
    Intent.THANKYOU: E03Intent.OTHER,
    Intent.COMPLAINT: E03Intent.OTHER,
    Intent.UNKNOWN: E03Intent.OTHER,
    Intent.ORDER_MODIFY: E03Intent.OTHER,
    Intent.ORDER_CANCEL: E03Intent.OTHER,
    Intent.PAYMENT_DISPUTE: E03Intent.OTHER,
    Intent.LEGAL_THREAT: E03Intent.OTHER,
    Intent.CUSTOM_REQUEST: E03Intent.OTHER,
}


@dataclass
class Plan:
    """What the pipeline decided to say. `reply` is the verified, template-built draft."""

    detailed_intent: Intent
    reply: str
    grounded: bool = False              # True -> the Generator may rewrite `reply` (guarded); False -> fixed template
    secondary: list[Intent] = field(default_factory=list)
    confidence: float = 0.0
    candidate: OrderCandidate | None = None
    review_reasons: list[ReviewReason] = field(default_factory=list)
    clarification: bool = False
    awaiting_confirmation: bool = False
    owner_review: bool = False          # flag the response (requiresReview=true) so the owner sees it right away
    protected_terms: list[str] = field(default_factory=list)   # product names the rewrite must keep verbatim

    @property
    def e03_intent(self) -> E03Intent:
        if self.candidate is not None:
            return E03Intent.CONFIRMED_ORDER
        return INTENT_TO_E03[self.detailed_intent]
