"""Request contract: what the NestJS backend sends to POST /v1/ai/respond.

Shapes mirror the backend's real tables (Business / BusinessSettings / WorkingHour / CatalogItem / Customer /
Message) so the backend can forward database rows as they are. Unknown extra fields are accepted and ignored.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_MESSAGE_CHARS = 2000
DayOfWeek = Literal["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]


class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore")


class BusinessSettings(_Loose):
    acceptsCash: bool = True
    acceptsOnlinePayment: bool = False
    deliveryEnabled: bool = False
    pickupEnabled: bool = True


class WorkingHour(_Loose):
    dayOfWeek: DayOfWeek
    isOpen: bool = False
    opensAt: str | None = None   # "09:00" (24h, no timezone)
    closesAt: str | None = None


class BusinessIn(_Loose):
    id: UUID
    name: str
    description: str | None = None
    category: str | None = None
    phone: str | None = None
    address: str | None = None
    settings: BusinessSettings = Field(default_factory=BusinessSettings)
    workingHours: list[WorkingHour] = Field(default_factory=list)  # a LIST of rows, as the backend returns it


class CustomerIn(_Loose):
    id: UUID
    phone: str | None = None
    name: str | None = None


class ConversationMessage(_Loose):
    id: UUID | str | None = None
    senderType: Literal["CUSTOMER", "AI", "OWNER"]
    content: str | None = None
    messageType: str = "TEXT"
    createdAt: str | None = None


class CatalogItem(_Loose):
    """One CatalogItem row. `attributes` is a flat owner-defined map, e.g. {"Material": "Cotton", "Color": "Black, Gray"}."""

    id: UUID | str
    name: str
    externalKey: str | None = None
    description: str | None = None
    category: str | None = None
    basePrice: Decimal | None = None
    trackInventory: bool = False
    stockQuantity: int | None = None
    attributes: dict[str, Any] | None = None
    isActive: bool = True

    @field_validator("attributes", mode="before")
    @classmethod
    def _attrs(cls, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}


class OrderLine(_Loose):
    name: str
    quantity: int = 1


class CustomerOrder(_Loose):
    """Optional (orders do not exist in the backend yet); enables order-status answers once they do."""

    orderNumber: int | str
    status: str
    items: list[OrderLine] = Field(default_factory=list)
    createdAt: str | None = None


class BusinessKnowledge(_Loose):
    """Owner-written knowledge (SCRUM-33). Empty today. `policies` keys: delivery | returns | payment | location."""

    policies: dict[str, str] = Field(default_factory=dict)
    faqs: list[dict[str, Any]] = Field(default_factory=list)  # [{question, answer, keywords?: [..]}]


class MessageIn(_Loose):
    id: UUID | None = None
    text: str


class AIRespondRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    business: BusinessIn
    customer: CustomerIn
    conversation: list[ConversationMessage] = Field(default_factory=list)
    catalog: list[CatalogItem] = Field(default_factory=list)
    businessKnowledge: BusinessKnowledge = Field(default_factory=BusinessKnowledge)
    customerOrders: list[CustomerOrder] = Field(default_factory=list)
    message: str | MessageIn
    messageId: UUID | None = None   # the stored id of the customer's message -> becomes orderCandidate.sourceMessageId

    @model_validator(mode="after")
    def _normalise(self) -> "AIRespondRequest":
        text = self.message.text if isinstance(self.message, MessageIn) else self.message
        text = (text or "").strip()
        if not text:
            raise ValueError("message must not be empty")
        if len(text) > MAX_MESSAGE_CHARS:
            raise ValueError(f"message must be at most {MAX_MESSAGE_CHARS} characters")
        if self.messageId is None and isinstance(self.message, MessageIn):
            self.messageId = self.message.id
        if self.messageId is None:
            raise ValueError("messageId is required (it becomes orderCandidate.sourceMessageId)")
        self.message = MessageIn(id=self.messageId, text=text)
        return self

    @property
    def text(self) -> str:
        assert isinstance(self.message, MessageIn)
        return self.message.text
