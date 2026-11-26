"""Response contract: E0-3 Structured Order Candidate JSON Contract, Schema 1.0, implemented literally.

Every model forbids extra fields (additionalProperties:false in the contract). The AI never sends prices, totals,
stock or status; the Backend fills those from the database.
"""
from __future__ import annotations

from enum import Enum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class E03Intent(str, Enum):
    INQUIRY = "INQUIRY"
    PURCHASE_INTENT = "PURCHASE_INTENT"
    CONFIRMED_ORDER = "CONFIRMED_ORDER"
    OTHER = "OTHER"


class ReviewReason(str, Enum):
    LOW_ITEM_CONFIDENCE = "LOW_ITEM_CONFIDENCE"   # decided by the Backend threshold, never set by the AI
    UNMATCHED_ITEM = "UNMATCHED_ITEM"
    VARIANT_UNCLEAR = "VARIANT_UNCLEAR"
    OUT_OF_STOCK_RISK = "OUT_OF_STOCK_RISK"
    AMBIGUOUS_QUANTITY = "AMBIGUOUS_QUANTITY"
    OTHER = "OTHER"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OrderCandidateItem(_Strict):
    catalogItemId: UUID | None
    variantId: UUID | None = None
    rawText: str = Field(min_length=1, max_length=300)
    quantity: int = Field(ge=1, le=100)
    selectedAttributes: dict[str, str] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=500)
    confidence: float = Field(ge=0, le=1)


class OrderCandidate(_Strict):
    sourceMessageId: UUID
    confidence: float = Field(ge=0, le=1)
    reviewReasons: list[ReviewReason] = Field(default_factory=list)
    notes: str | None = Field(default=None, max_length=1000)
    items: list[OrderCandidateItem] = Field(min_length=1, max_length=50)


class AiResponse(_Strict):
    intent: E03Intent
    reply: str = Field(min_length=1)
    requiresReview: bool
    orderCandidate: OrderCandidate | None

    @model_validator(mode="after")
    def _v2(self) -> "AiResponse":
        # V2: orderCandidate is null unless intent == CONFIRMED_ORDER, and present when it is.
        if (self.intent == E03Intent.CONFIRMED_ORDER) != (self.orderCandidate is not None):
            raise ValueError("orderCandidate must be present exactly when intent is CONFIRMED_ORDER")
        # V9: the review flag can only be raised by reasons, never hidden.
        if self.orderCandidate and self.orderCandidate.reviewReasons and not self.requiresReview:
            raise ValueError("requiresReview must be true when reviewReasons is not empty")
        return self
