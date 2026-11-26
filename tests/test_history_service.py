"""Offline history traversal; timestamp ordering is tested as provisional only."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
from uuid import UUID

import httpx
import pytest

from app.clients.backend_client import BackendClient
from app.data.backend import BackendDataAccess
from app.data.history import HistoryCoverage as Coverage, HistoryLimits, HistoryService
from app.schemas.backend import ExpectedScope, RetrievalStatus
from tests.backend_contract_fixtures import (
    ATTACK, BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B,
    CONVERSATION_A, CONVERSATION_B, HISTORIES, PRODUCT_A, PRODUCTS,
)

SCOPE = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_A, conversation_id=CONVERSATION_A)


def row(identity, content="hello", timestamp="2026-11-03T10:00:00Z", sender="CUSTOMER"):
    return {"id": identity, "content": content, "senderType": sender,
            "messageType": "TEXT", "createdAt": timestamp}


def setup(rows=(), *, limits=None, handler=None, clock=None):
    calls = []
    def respond(request):
        arguments = json.loads(request.content)["arguments"]
        calls.append((arguments, request.headers["X-AI-Context"]))
        if handler is not None:
            return handler(request, arguments, len(calls))
        offset, limit = arguments["offset"], arguments["limit"]
        items = deepcopy(rows[offset:offset + limit])
        more = offset + limit < len(rows)
        return httpx.Response(200, json={"tool": "get_conversation_history", "data": {
            "items": items, "pagination": {"limit": limit, "offset": offset, "totalCount": len(rows),
                                           "hasMore": more, "nextOffset": offset + limit if more else None}}})
    client = BackendClient("https://backend.test", "fixture-service", transport=httpx.MockTransport(respond))
    service = HistoryService(BackendDataAccess(client), limits, **({"clock": clock} if clock else {}))
    return service, calls


def prepare(service, current="current", text="yes", scope=SCOPE):
    return asyncio.run(service.prepare(scope.conversation_id, current, text, scope=scope, context_token="fixture-context"))


@pytest.mark.parametrize("name", ["arabic_reference", "english_ambiguous", "franco_reference"])
def test_fixture_history_sorted_with_roles_but_boundary_remains_provisional(name):
    fixture = HISTORIES[name]
    service, calls = setup(fixture["rows"], limits=HistoryLimits(page_size=2, max_pages=4))
    result = prepare(service, fixture["currentMessageId"], fixture["currentText"])
    assert result.coverage == Coverage.COMPLETE  # terminal traversal, not a snapshot
    assert result.chronology_uncertain
    assert "timestamp_boundary_provisional" in result.issues
    assert [t.message_id for t in result.messages] == fixture["expectedPriorIds"]
    assert [t.sender_type for t in result.messages] == [r["senderType"] for r in reversed(fixture["rows"][1:])]
    assert all(t.timestamp.tzinfo == timezone.utc for t in result.messages)
    assert all(t.message_id != fixture["currentMessageId"] for t in result.messages)
    assert result.followup_requires_clarification
    assert all(h.requires_revalidation for h in result.references)
    assert all(set(arguments) == {"conversationId", "limit", "offset"} for arguments, _ in calls)


def test_same_text_different_ids_survives_current_id_exclusion():
    rows = [row("current", "same", "2026-11-03T10:02:00Z"),
            row("b", "same", "2026-11-03T10:01:00Z"), row("a", "same")]
    service, _ = setup(rows)
    result = prepare(service, text="same")
    assert [t.message_id for t in result.messages] == ["a", "b"]
    assert [t.content for t in result.messages] == ["same", "same"]


def test_duplicates_across_pages_use_ids_and_do_not_duplicate_context():
    rows = [row("current", timestamp="2026-11-03T10:02:00Z"), row("a"), row("a"), row("b")]
    service, _ = setup(rows, limits=HistoryLimits(page_size=2))
    result = prepare(service)
    assert result.coverage == Coverage.COMPLETE
    assert [t.message_id for t in result.messages] == ["a", "b"]
    assert "timestamp_tie" in result.issues and result.chronology_uncertain


def test_uuid_identity_is_case_insensitive_and_original_id_preserved():
    identity = "A0000000-0000-4000-8000-000000000001"
    service, _ = setup([row(identity, timestamp="2026-11-03T10:01:00Z"), row(identity.lower(), timestamp="2026-11-03T10:01:00Z"), row("old")])
    result = prepare(service, identity.lower())
    assert [t.message_id for t in result.messages] == ["old"]
    assert not result.uncertain_messages


def test_conflicting_duplicate_removed_instead_of_arbitrary_selection():
    service, _ = setup([row("current", timestamp="2026-11-03T10:02:00Z"), row("a", "one"), row("a", "different")])
    result = prepare(service)
    assert result.coverage == Coverage.PARTIAL and result.messages == ()
    assert "conflicting_duplicate" in result.issues


def test_conflicting_current_message_does_not_create_a_boundary():
    service, _ = setup([row("current", timestamp="2026-11-03T10:02:00Z"), row("current"), row("old")])
    result = prepare(service)
    assert result.messages == () and result.uncertain_messages[0].message_id == "old"
    assert "current_boundary_unknown" in result.issues


def test_timezone_offsets_are_parsed_and_ties_sorted_by_id_not_claimed_causal():
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00+00:00"),
                        row("z", timestamp="2026-11-03T12:00:00+02:00"),
                        row("a", timestamp="2026-11-03T10:00:00Z")])
    result = prepare(service)
    assert [t.message_id for t in result.messages] == ["a", "z"]
    assert result.messages[0].timestamp == result.messages[1].timestamp == datetime(2026, 11, 3, 10, tzinfo=timezone.utc)
    assert "timestamp_tie" in result.issues


@pytest.mark.parametrize("timestamp", [None, "not-a-date", "2026-11-03", "2026-11-03T10:00:00",
    "2026-02-30T10:00:00Z", "2026-11-03T10:00:00.1234567Z", "2026-11-03T10:00:00-00:00"])
def test_missing_malformed_and_naive_timestamps_do_not_invent_order(timestamp):
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z"), row("unknown", timestamp=timestamp)])
    result = prepare(service)
    assert result.messages == ()
    assert result.uncertain_messages[0].timestamp is None
    assert result.uncertain_messages[0].original_timestamp == timestamp
    assert result.chronology_uncertain and "uncertain_chronology" in result.issues


def test_later_and_equal_time_rows_are_never_silently_prior_history():
    service, _ = setup([row("future", timestamp="2026-11-03T12:00:00Z"),
                        row("current", timestamp="2026-11-03T11:00:00Z"),
                        row("tied", timestamp="2026-11-03T11:00:00Z"), row("prior")])
    result = prepare(service)
    assert [t.message_id for t in result.messages] == ["prior"]
    assert [t.message_id for t in result.uncertain_messages] == ["tied"]
    assert "later_message_excluded" in result.issues


def test_current_missing_means_no_before_current_assumption_from_page_order():
    service, _ = setup([row("b", timestamp="2026-11-03T11:00:00Z"), row("a")])
    result = prepare(service)
    assert result.messages == () and [t.message_id for t in result.uncertain_messages] == ["b", "a"]
    assert result.references == () and result.chronology_uncertain


def test_noncustomer_current_row_cannot_establish_current_customer_boundary():
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z", sender="AI"), row("old")])
    result = prepare(service)
    assert result.messages == () and result.uncertain_messages[0].message_id == "old"
    assert "current_boundary_unknown" in result.issues


def test_empty_history_is_a_terminal_page_not_missing_history_failure():
    service, calls = setup()
    result = prepare(service)
    assert result.coverage == Coverage.COMPLETE and result.failure is None
    assert result.messages == result.uncertain_messages == () and len(calls) == 1
    assert result.followup_requires_clarification


@pytest.mark.parametrize("identity", [None, "", " ", "invalid\nidentity", "x" * 129])
def test_missing_or_unusable_message_ids_are_excluded_and_mark_partial(identity):
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z"), row(identity)])
    result = prepare(service)
    assert result.coverage == Coverage.PARTIAL and result.messages == ()
    assert "invalid_message_id" in result.issues


@pytest.mark.parametrize("identity", [None, 12, "", "bad\nid"])
def test_invalid_current_id_fails_without_retrieval(identity):
    service, calls = setup()
    result = prepare(service, identity)
    assert result.coverage == Coverage.UNAVAILABLE and calls == []


@pytest.mark.parametrize("text", ["منه", "نفس المقاس", "yes", "عايزة اتنين", "3ayez etneen meno"])
def test_ambiguous_followups_require_clarification_not_order_actions(text):
    service, _ = setup()
    result = prepare(service, text=text)
    assert result.followup_requires_clarification
    assert result.references == ()


def test_reference_hints_are_untrusted_options_terms_and_explicit_ids_only():
    variant_id = PRODUCTS[0]["variants"][0]["id"]
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z"),
                        row("question", "Which size?", "2026-11-03T10:01:00Z", "OWNER"),
                        row("product", f"T-Shirt black size M productId={PRODUCT_A} variantId={variant_id}", sender="AI")])
    result = prepare(service)
    hint = next(h for h in result.references if h.message_id == "product")
    assert hint.product_id == UUID(PRODUCT_A) and hint.variant_id == UUID(variant_id)
    assert hint.requires_revalidation and hint.size == "M" and hint.product_terms
    assert result.clarification_message_ids == ("question",)
    assert not hasattr(hint, "price") and not hasattr(hint, "stockQuantity")


def test_multiple_labeled_product_ids_are_not_arbitrarily_resolved():
    service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z"),
                        row("ambiguous", f"productId={PRODUCT_A} productId={PRODUCTS[1]['id']}")])
    assert prepare(service).references[0].product_id is None


@pytest.mark.parametrize("sender", ["CUSTOMER", "AI", "OWNER"])
def test_historical_injection_does_not_change_tools_scope_or_diagnostics(sender):
    service, calls = setup([row("current", timestamp="2026-11-03T11:00:00Z"), row("attack", ATTACK, sender=sender)])
    result = prepare(service)
    assert result.messages[0].content == ATTACK  # retained as untrusted data
    assert len(calls) == 1 and calls[0][0]["conversationId"] == CONVERSATION_A
    assert ATTACK not in repr(result) and "fixture-context" not in repr(result)
    assert result.references[0].product_id is None


@pytest.mark.parametrize("limits,expected,maximum", [
    (HistoryLimits(max_pages=1, page_size=1), "page_limit", 1),
    (HistoryLimits(max_messages=2, page_size=1), "message_limit", 2),
    (HistoryLimits(max_characters=3), "character_limit", 1),
])
def test_retrieval_budgets_are_bounded_and_mark_partial(limits, expected, maximum):
    service, calls = setup([row(str(n), "lengthy") for n in range(5)], limits=limits)
    result = prepare(service)
    assert result.coverage == Coverage.PARTIAL and expected in result.issues
    assert len(calls) <= maximum
    assert result.rows_examined <= limits.max_messages
    assert result.characters_examined <= limits.max_characters


def test_empty_nonterminal_pages_cannot_loop_without_bound():
    def handler(request, arguments, call):
        return httpx.Response(200, json={"tool": "get_conversation_history", "data": {
            "items": [], "pagination": {"limit": arguments["limit"], "offset": arguments["offset"],
            "totalCount": 100, "hasMore": True, "nextOffset": arguments["offset"] + 20}}})
    service, calls = setup(handler=handler, limits=HistoryLimits(max_pages=2))
    result = prepare(service)
    assert result.coverage == Coverage.PARTIAL and len(calls) == 2


@pytest.mark.parametrize("status,expected", [(401, RetrievalStatus.AUTHORIZATION_FAILED),
    (403, RetrievalStatus.AUTHORIZATION_FAILED), (503, RetrievalStatus.UNAVAILABLE)])
def test_backend_failure_is_unavailable_without_other_tenant_lookup(status, expected):
    service, calls = setup(handler=lambda *args: httpx.Response(status, text="PRIVATE fixture-context"))
    result = prepare(service)
    assert result.coverage == Coverage.UNAVAILABLE and result.failure == expected
    assert result.messages == () and len(calls) == 1
    assert "PRIVATE" not in repr(result) and "fixture-context" not in repr(result)


@pytest.mark.parametrize("status", [403, 503])
def test_later_page_failure_discards_auth_evidence_but_retains_partial_on_transient_failure(status):
    def handler(request, args, call):
        if call == 2:
            return httpx.Response(status)
        return httpx.Response(200, json={"tool": "get_conversation_history", "data": {
            "items": [row("current", timestamp="2026-11-03T11:00:00Z"), row("old")],
            "pagination": {"limit": 2, "offset": 0, "totalCount": 4, "hasMore": True, "nextOffset": 2}}})
    service, calls = setup(handler=handler, limits=HistoryLimits(page_size=2))
    result = prepare(service)
    assert len(calls) == 2
    if status == 403:
        assert result.coverage == Coverage.UNAVAILABLE and result.messages == result.references == ()
    else:
        assert result.coverage == Coverage.PARTIAL and result.messages[0].message_id == "old"


def test_scope_mismatch_does_not_send_request():
    service, calls = setup()
    result = asyncio.run(service.prepare(CONVERSATION_B, "current", "yes", scope=SCOPE, context_token="fixture-context"))
    assert result.failure == RetrievalStatus.SCOPE_MISMATCH and calls == []


def test_backend_timeout_is_sanitized():
    def handler(request, *args):
        raise httpx.ReadTimeout("PRIVATE fixture-context", request=request)
    service, _ = setup(handler=handler)
    result = prepare(service)
    assert result.coverage == Coverage.UNAVAILABLE and "timeout" in result.issues


@pytest.mark.parametrize("data", [{}, {"items": [], "pagination": {}},
    {"items": [{"id": 12, "senderType": "CUSTOMER"}], "pagination": {
        "limit": 20, "offset": 0, "totalCount": 1, "hasMore": False, "nextOffset": None}}])
def test_invalid_backend_history_is_not_converted_into_empty_complete_history(data):
    service, _ = setup(handler=lambda *args: httpx.Response(200, json={"tool": "get_conversation_history", "data": data}))
    result = prepare(service)
    assert result.coverage == Coverage.UNAVAILABLE and result.failure == RetrievalStatus.INVALID
    assert result.messages == result.uncertain_messages == ()


def test_exhausted_elapsed_budget_before_first_call_is_unavailable():
    ticks = iter([0, 10])
    service, calls = setup(clock=lambda: next(ticks))
    result = prepare(service)
    assert result.coverage == Coverage.UNAVAILABLE and calls == []
    assert "elapsed_limit" in result.issues


def test_elapsed_budget_cancels_slow_retrieval():
    class SlowData:
        async def get_conversation_history(self, *args, **kwargs):
            await asyncio.sleep(1)
            pytest.fail("Should have been cancelled")
    service = HistoryService(SlowData(), HistoryLimits(max_elapsed_seconds=0.001))
    result = prepare(service)
    assert result.coverage == Coverage.UNAVAILABLE and "elapsed_limit" in result.issues


@pytest.mark.parametrize("same_business", [True, False])
def test_overlapping_customer_histories_have_no_shared_request_state(same_business):
    class Data:
        async def get_conversation_history(self, conversation_id, limit, offset, *, scope, context_token):
            await asyncio.sleep(0)
            # Reuse the actual typed adapter, while keeping fake records scoped.
            label = "Alpha" if scope.customer_id == UUID(CUSTOMER_A) else "Beta"
            local_service, _ = setup([row("current", timestamp="2026-11-03T11:00:00Z"), row("old", label)])
            return await local_service._data.get_conversation_history(
                conversation_id, limit, offset, scope=scope, context_token=context_token)
    async def run():
        service = HistoryService(Data())
        other = ExpectedScope(business_id=BUSINESS_A if same_business else BUSINESS_B,
                              customer_id=CUSTOMER_B, conversation_id=CONVERSATION_B)
        first, second = await asyncio.gather(
            service.prepare(CONVERSATION_A, "current", "yes", scope=SCOPE, context_token="fixture-a"),
            service.prepare(CONVERSATION_B, "current", "yes", scope=other, context_token="fixture-b"))
        assert first.messages[0].content == "Alpha" and second.messages[0].content == "Beta"
        assert first.messages is not second.messages and first.references is not second.references
        assert set(vars(service)) == {"_data", "_limits", "_clock"}
        assert "fixture-a" not in repr(first) and "Beta" not in repr(first)
    asyncio.run(run())


@pytest.mark.parametrize("kwargs", [{"max_pages": 0}, {"max_messages": True}, {"max_characters": -1},
    {"page_size": 101}, {"max_elapsed_seconds": float("nan")}, {"max_elapsed_seconds": 0}])
def test_invalid_budgets_rejected(kwargs):
    with pytest.raises(ValueError):
        HistoryLimits(**kwargs)
