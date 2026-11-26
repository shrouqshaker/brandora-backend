"""Bounded optional history preparation and shared contextual-reference cues.

Coverage describes page traversal, NOT a snapshot or proven before-current order.
Earlier timestamp candidates remain provisional until Backend ordering is agreed.
All returned content is untrusted data, never instructions or current facts.
"""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import math
import re
import time
from typing import Callable
from uuid import UUID

from ..nlu import extract_entities, is_pure_confirmation, normalize
from ..schemas.backend import ExpectedScope, HistoryMessage, RetrievalStatus
from .backend import BackendDataAccess


class HistoryCoverage(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class HistoryLimits:
    max_pages: int = 3
    max_messages: int = 60
    max_characters: int = 12000
    max_elapsed_seconds: float = 5.0
    page_size: int = 20

    def __post_init__(self):
        for value in (self.max_pages, self.max_messages, self.max_characters, self.page_size):
            if type(value) is not int or value <= 0:
                raise ValueError("History limits must be positive integers")
        if self.page_size > 100:
            raise ValueError("History page size exceeds Backend limit")
        if (isinstance(self.max_elapsed_seconds, bool)
                or not isinstance(self.max_elapsed_seconds, (int, float))
                or not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0):
            raise ValueError("History deadline must be positive and finite")


@dataclass(frozen=True)
class HistoryTurn:
    message_id: str = field(repr=False)
    sender_type: str
    content: str | None = field(repr=False)
    message_type: str | None
    timestamp: datetime | None = field(repr=False)
    original_timestamp: str | None = field(repr=False)


@dataclass(frozen=True)
class ReferenceHint:
    message_id: str = field(repr=False)
    sender_type: str
    product_terms: tuple[str, ...] = field(repr=False)
    color: str | None = field(repr=False)
    size: str | None = field(repr=False)
    requested_quantity: int | None = field(repr=False)
    product_id: UUID | None = field(repr=False)
    variant_id: UUID | None = field(repr=False)
    # Historical IDs/terms are references only. No facts or authorization attach.
    requires_revalidation: bool = True


@dataclass(frozen=True)
class PreparedHistory:
    coverage: HistoryCoverage
    messages: tuple[HistoryTurn, ...] = field(default=(), repr=False)
    uncertain_messages: tuple[HistoryTurn, ...] = field(default=(), repr=False)
    references: tuple[ReferenceHint, ...] = field(default=(), repr=False)
    clarification_message_ids: tuple[str, ...] = field(default=(), repr=False)
    followup_requires_clarification: bool = False
    chronology_uncertain: bool = True
    issues: tuple[str, ...] = ()
    failure: RetrievalStatus | None = None
    pages_fetched: int = 0
    rows_examined: int = 0
    characters_examined: int = 0


_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})")
_LABELED_ID = re.compile(r"\b(productId|variantId)\s*[:=]\s*([0-9a-fA-F-]{36})(?![0-9a-fA-F-])")


def _timestamp(value: str | None) -> datetime | None:
    if value is None or not _TIMESTAMP.fullmatch(value) or value.endswith("-00:00"):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def _identity(value: str | None) -> str | None:
    # Existing history schema permits opaque string IDs, not just UUIDs.
    if not value or len(value) > 128 or value != value.strip() or not value.isprintable():
        return None
    try:
        parsed = UUID(value)
    except ValueError:
        return value
    return str(parsed) if str(parsed) == value.lower() else value


def is_contextual_followup(text: str) -> bool:
    """Conservative follow-up cue shared by preparation and retrieval policy."""
    normalized = normalize(text)
    entities = extract_entities(text)
    references = {"منه", "منها", "نفس المقاس", "نفس اللون", "meno", "menha", "same size", "same color", "that one"}
    return (is_pure_confirmation(text)
            or any(re.search(r"(?:^|\s)" + re.escape(term) + r"(?:$|\s)", normalized) for term in references)
            or bool(entities.quantity and not entities.product_tokens))


def _reference(turn: HistoryTurn) -> ReferenceHint:
    entities = extract_entities(turn.content or "")
    ids = {}
    for label, value in _LABELED_ID.findall(turn.content or ""):
        try:
            identifier = UUID(value)
        except ValueError:
            continue
        # Multiple different IDs for one label are ambiguous; never select one.
        ids.setdefault(label, set()).add(identifier)
    return ReferenceHint(
        message_id=turn.message_id, sender_type=turn.sender_type,
        product_terms=tuple(token.orig for token in entities.product_tokens),
        color=entities.raw_color or entities.color, size=entities.size,
        requested_quantity=entities.quantity,
        product_id=next(iter(ids["productId"])) if len(ids.get("productId", ())) == 1 else None,
        variant_id=next(iter(ids["variantId"])) if len(ids.get("variantId", ())) == 1 else None,
    )


def _prepare(rows: list[HistoryMessage], current_id: str, current_text: str,
             coverage: HistoryCoverage, issues: list[str], expired: Callable[[], bool], **metadata) -> PreparedHistory:
    unique: dict[str, HistoryTurn] = {}
    conflicts = set()
    for row in rows:
        if expired():
            coverage = HistoryCoverage.PARTIAL
            issues.append("elapsed_limit")
            break
        identity = _identity(row.id)
        if identity is None:
            issues.append("invalid_message_id")
            continue
        turn = HistoryTurn(row.id, row.senderType, row.content, row.messageType,
                           _timestamp(row.createdAt), row.createdAt)
        if identity in unique:
            if unique[identity] != turn:
                # Same UUID with only case differences still has the same identity.
                old = unique[identity]
                if (old.sender_type, old.content, old.message_type, old.original_timestamp) != (
                        turn.sender_type, turn.content, turn.message_type, turn.original_timestamp):
                    conflicts.add(identity)
                    issues.append("conflicting_duplicate")
            continue
        unique[identity] = turn
    for identity in conflicts:
        del unique[identity]
    anchor = unique.pop(current_id, None)
    boundary = anchor.timestamp if anchor is not None and anchor.sender_type == "CUSTOMER" else None
    if boundary is None:
        issues.append("current_boundary_unknown")
    else:
        issues.append("timestamp_boundary_provisional")
    prior, uncertain = [], []
    for turn in unique.values():
        if turn.message_type is None or turn.message_type.upper() != "TEXT":
            issues.append("nontext_or_unknown_message_type")
            continue
        if boundary is None or turn.timestamp is None or turn.timestamp == boundary:
            uncertain.append(turn)
            issues.append("uncertain_chronology")
        elif turn.timestamp > boundary:
            issues.append("later_message_excluded")
        else:
            prior.append(turn)
    # ID tie-breaking is deterministic presentation, NOT evidence of causal order.
    prior.sort(key=lambda turn: (turn.timestamp, _identity(turn.message_id)))
    if len({turn.timestamp for turn in prior}) != len(prior):
        issues.append("timestamp_tie")
    # Uncertain rows retain first-seen retrieval order; no chronology is invented.
    questions = ()
    if prior:
        latest = [turn for turn in prior if turn.timestamp == prior[-1].timestamp]
        questions = tuple(turn.message_id for turn in latest
                          if turn.sender_type in {"AI", "OWNER"} and (turn.content or "").rstrip().endswith(("?", "؟")))
    if "invalid_message_id" in issues or conflicts:
        coverage = HistoryCoverage.PARTIAL
    references = []
    for turn in prior:
        if expired():
            coverage = HistoryCoverage.PARTIAL
            issues.append("elapsed_limit")
            break
        references.append(_reference(turn))
    return PreparedHistory(
        coverage=coverage, messages=tuple(prior), uncertain_messages=tuple(uncertain),
        references=tuple(references), clarification_message_ids=questions,
        followup_requires_clarification=is_contextual_followup(current_text),
        chronology_uncertain=bool(rows) or coverage != HistoryCoverage.COMPLETE,
        issues=tuple(dict.fromkeys(issues)), **metadata,
    )


class HistoryService:
    def __init__(self, data: BackendDataAccess, limits: HistoryLimits | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self._data = data
        self._limits = limits or HistoryLimits()
        self._clock = clock

    async def prepare_authorized(self, current_message_id: UUID, *, scope: ExpectedScope,
                                 context_token: str) -> PreparedHistory:
        """Strict scoped/snapshot mode for canonical internal tools.

        Legacy PR pages remain provisional in prepare(); they are never promoted
        to authenticated evidence by this mode.
        """
        deadline=self._clock()+self._limits.max_elapsed_seconds
        rows,seen,customer_times=[],{},set()
        pages=examined=characters=offset=0
        metadata=None
        previous=None
        def result(coverage,issue=None,failure=None):
            ordered=tuple(sorted(rows,key=lambda r:(r.timestamp,UUID(r.message_id).int))) if coverage==HistoryCoverage.COMPLETE else ()
            return PreparedHistory(coverage,messages=ordered,chronology_uncertain=coverage!=HistoryCoverage.COMPLETE,
                issues=(issue,) if issue else (),failure=failure,pages_fetched=pages,rows_examined=examined,
                characters_examined=characters)
        if scope.customer_id is None or scope.conversation_id is None:
            return result(HistoryCoverage.UNAVAILABLE,"scope_mismatch",RetrievalStatus.SCOPE_MISMATCH)
        while pages < self._limits.max_pages and examined < self._limits.max_messages:
            remaining=deadline-self._clock()
            if remaining <= 0:
                return result(HistoryCoverage.PARTIAL,"history_time_limit")
            try:
                limit=min(self._limits.page_size,self._limits.max_messages-examined)
                outcome=await asyncio.wait_for(self._data.get_conversation_history(scope.conversation_id,limit,offset,
                    scope=scope,context_token=context_token,before_message_id=current_message_id),timeout=remaining)
            except asyncio.TimeoutError:
                return result(HistoryCoverage.UNAVAILABLE,"history_timeout")
            pages+=1
            if outcome.envelope is None:
                return result(HistoryCoverage.UNAVAILABLE,outcome.error or "history_unavailable",outcome.status)
            page=outcome.envelope.data
            boundary=_timestamp(page.beforeMessageCreatedAt)
            if boundary is None or not page.snapshot.strip():
                return result(HistoryCoverage.UNAVAILABLE,"invalid_history_boundary",RetrievalStatus.INVALID)
            current_metadata=(page.snapshot,boundary,page.pagination.totalCount)
            if metadata is not None and metadata != current_metadata:
                return result(HistoryCoverage.PARTIAL,"history_snapshot_changed")
            metadata=current_metadata
            if not page.complete or page.pagination.totalCount > self._limits.max_messages:
                return result(HistoryCoverage.PARTIAL,"incomplete_history")
            for row in page.items:
                examined+=1
                characters+=len(row.content or "")
                if characters > self._limits.max_characters or self._clock() >= deadline:
                    return result(HistoryCoverage.PARTIAL,"history_budget_exceeded")
                stamp=_timestamp(row.createdAt)
                if stamp is None or stamp >= boundary or row.id == current_message_id:
                    return result(HistoryCoverage.PARTIAL,"ambiguous_history_boundary")
                key=(stamp,row.id.int)
                if previous is not None and key > previous:
                    return result(HistoryCoverage.UNAVAILABLE,"invalid_history_order",RetrievalStatus.INVALID)
                previous=key
                if row.id in seen:
                    if seen[row.id] != row:
                        return result(HistoryCoverage.PARTIAL,"conflicting_history_duplicate")
                    continue
                seen[row.id]=row
                if row.senderType=="CUSTOMER":
                    if stamp in customer_times:
                        return result(HistoryCoverage.PARTIAL,"ambiguous_customer_timestamp")
                    customer_times.add(stamp)
                    if row.messageType!="TEXT" or not row.content or not row.content.strip() or len(row.content)>2000:
                        return result(HistoryCoverage.PARTIAL,"unsupported_customer_message")
                rows.append(HistoryTurn(str(row.id),row.senderType,row.content,row.messageType,stamp,row.createdAt))
            if not page.pagination.hasMore:
                if examined != page.pagination.totalCount:
                    return result(HistoryCoverage.PARTIAL,"incomplete_history_count")
                return result(HistoryCoverage.COMPLETE)
            offset=page.pagination.nextOffset
        return result(HistoryCoverage.PARTIAL,"history_page_or_message_limit")

    async def prepare(self, conversation_id: UUID, current_message_id: str, current_text: str, *,
                      scope: ExpectedScope, context_token: str) -> PreparedHistory:
        current_id = (_identity(str(current_message_id))
                      if isinstance(current_message_id, (str, UUID)) else None)
        if current_id is None:
            return PreparedHistory(HistoryCoverage.UNAVAILABLE, issues=("invalid_current_message_id",), failure=RetrievalStatus.INVALID)
        rows, issues = [], []
        pages = examined = characters = offset = 0
        coverage = HistoryCoverage.PARTIAL
        failure = None
        deadline = self._clock() + self._limits.max_elapsed_seconds
        while pages < self._limits.max_pages and examined < self._limits.max_messages:
            remaining = deadline - self._clock()
            if remaining <= 0:
                issues.append("elapsed_limit")
                failure = RetrievalStatus.UNAVAILABLE
                break
            limit = min(self._limits.page_size, self._limits.max_messages - examined)
            try:
                result = await asyncio.wait_for(self._data.get_conversation_history(
                    conversation_id, limit, offset, scope=scope, context_token=context_token), timeout=remaining)
            except asyncio.TimeoutError:
                issues.append("elapsed_limit")
                failure = RetrievalStatus.UNAVAILABLE
                break
            pages += 1
            if result.envelope is None:
                failure = result.status
                issues.append(result.error or "history_unavailable")
                if result.status in {RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH}:
                    # Even previously retrieved rows cannot survive an auth failure.
                    return PreparedHistory(HistoryCoverage.UNAVAILABLE, issues=tuple(dict.fromkeys(issues)),
                                           failure=failure, pages_fetched=pages, rows_examined=examined,
                                           characters_examined=characters)
                break
            page = result.envelope.data
            limited = False
            for row in page.items:
                if self._clock() >= deadline:
                    issues.append("elapsed_limit")
                    failure = RetrievalStatus.UNAVAILABLE
                    limited = True
                    break
                examined += 1
                length = len(row.content or "")
                if characters + length > self._limits.max_characters:
                    issues.append("character_limit")
                    limited = True
                    break
                characters += length
                rows.append(row)
            if limited:
                break
            if not page.pagination.hasMore:
                coverage = HistoryCoverage.COMPLETE
                break
            offset = page.pagination.nextOffset
        else:
            issues.append("page_limit" if pages >= self._limits.max_pages else "message_limit")
        if failure is not None and not rows:
            coverage = HistoryCoverage.UNAVAILABLE
        return _prepare(rows, current_id, current_text, coverage, issues, failure=failure,
                        expired=lambda: self._clock() >= deadline,
                        pages_fetched=pages, rows_examined=examined, characters_examined=characters)
