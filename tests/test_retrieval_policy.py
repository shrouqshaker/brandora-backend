"""Offline retrieval policy tests: tool counts, budgets, scope and evidence."""
import asyncio
from copy import deepcopy
import json
from uuid import UUID

import httpx
import pytest

from app.clients.backend_client import BackendClient
from app.data.backend import BackendDataAccess
from app.data.history import HistoryCoverage, PreparedHistory, ReferenceHint
from app.data.retrieval import (
    RetrievalCoordinator, RetrievalDecision as Decision, RetrievalLimits,
    RetrievalQuery, SearchCoverage as Coverage,
)
from app.schemas.backend import ExpectedScope, InventoryState, RetrievalStatus as Status
from tests.backend_contract_fixtures import (
    ATTACK, BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B,
    CONVERSATION_A, CONVERSATION_B, PRODUCT_A, PRODUCTS,
)

SCOPE = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_A, conversation_id=CONVERSATION_A)


def setup(products=None, *, limits=None, handler=None):
    records = deepcopy(PRODUCTS[:3] if products is None else products)
    details = {p["id"]: p for p in records}
    calls = []
    def respond(request):
        payload = json.loads(request.content)
        calls.append((payload["tool"], payload["arguments"], request.headers["X-AI-Context"]))
        assert request.headers["Authorization"] == "Bearer fixture-service"
        if handler:
            response = handler(request, payload["tool"], payload["arguments"], len(calls))
            if response is not None:
                return response
        tool, args = payload["tool"], payload["arguments"]
        if tool == "get_business_info":
            data = {"business": {"id": BUSINESS_A, "name": "Fixture Store"}}
        elif tool == "get_product_details":
            if args["productId"] not in details:
                return httpx.Response(404)
            data = details[args["productId"]]
        elif tool == "get_variant_details":
            product = details.get(args["productId"])
            data = next((v for v in product["variants"] if v["id"] == args["variantId"]), None) if product else None
            if data is None:
                return httpx.Response(404)
        elif tool in {"get_products", "get_product_variants"}:
            rows = records if tool == "get_products" else details[args["productId"]]["variants"]
            offset, limit = args["offset"], args["limit"]
            more = offset + limit < len(rows)
            data = {"items": rows[offset:offset + limit], "pagination": {
                "limit": limit, "offset": offset, "totalCount": len(rows), "hasMore": more,
                "nextOffset": offset + limit if more else None}}
        else:
            pytest.fail("Unexpected tool")
        return httpx.Response(200, json={"tool": tool, "data": data})
    data = BackendDataAccess(BackendClient("https://backend.test", "fixture-service", transport=httpx.MockTransport(respond)))
    return RetrievalCoordinator(data, limits), calls


def retrieve(coordinator, text="what products do you have?", **kwargs):
    product_ids = kwargs.pop("product_ids", ())
    variants = kwargs.pop("variant_references", ())
    return asyncio.run(coordinator.retrieve(RetrievalQuery(text=text, product_ids=product_ids, variant_references=variants),
                                           scope=SCOPE, context_token="fixture-a", **kwargs))


def history(*pairs, failure=None):
    return PreparedHistory(HistoryCoverage.PARTIAL, references=tuple(
        ReferenceHint(str(index), "AI", ("untrusted",), None, None, None, UUID(p), UUID(v) if v else None)
        for index, (p, v) in enumerate(pairs)), failure=failure, followup_requires_clarification=True)


@pytest.mark.parametrize("text", ["hi", "thanks", "السلام عليكم", "شكرا"])
def test_pure_greetings_and_thanks_never_call_backend(text):
    coordinator, calls = setup()
    result = retrieve(coordinator, text)
    assert result.decision == Decision.SKIP and result.backend_calls == 0 and calls == []
    assert result.evidence == () and result.catalog_coverage == Coverage.NOT_SEARCHED


@pytest.mark.parametrize("text", ["where is my order?", "cancel my order", "I paid and nobody replied",
    "what is your return policy?", "do you deliver?", "can I pay online?"])
def test_unavailable_actions_and_policies_use_no_tools(text):
    coordinator, calls = setup()
    result = retrieve(coordinator, text)
    assert result.decision == Decision.UNSUPPORTED and calls == []
    assert not result.candidates and not result.variants


def test_supported_business_identity_uses_only_business_info():
    coordinator, calls = setup()
    result = retrieve(coordinator, "what is your business name?")
    assert result.decision == Decision.BUSINESS and result.status == Status.AVAILABLE
    assert [c[0] for c in calls] == ["get_business_info"] and calls[0][1] == {}
    assert result.evidence[0].envelope.data.business.name == "Fixture Store"


def test_browsing_stops_after_useful_page_and_marks_catalog_partial():
    coordinator, calls = setup(limits=RetrievalLimits(page_size=1))
    result = retrieve(coordinator)
    assert [c[0] for c in calls] == ["get_products"]
    assert result.catalog_coverage == Coverage.PARTIAL and result.status == Status.PARTIAL
    assert result.candidates[0].id == UUID(PRODUCT_A)
    assert result.variants == ()  # browsing did not ask for variant facts


def test_bounded_local_search_follows_backend_continuations_until_match():
    products = [deepcopy(PRODUCTS[2]), deepcopy(PRODUCTS[0])]
    coordinator, calls = setup(products, limits=RetrievalLimits(page_size=1))
    result = retrieve(coordinator, "how much is the T-Shirt?")
    assert [c[0] for c in calls] == ["get_products", "get_products", "get_product_details"]
    assert [c[1]["offset"] for c in calls[:2]] == [0, 1]
    assert result.catalog_coverage == Coverage.EXHAUSTED
    assert result.candidates[0].id == UUID(PRODUCT_A)
    assert all(v.catalogItemId == UUID(PRODUCT_A) for v in result.variants)


@pytest.mark.parametrize("text", ["عايز تيشيرت", "do you have a T-Shirt?", "3ayez tshirt"])
def test_existing_multilingual_matching_selects_only_plausible_products(text):
    coordinator, calls = setup([PRODUCTS[0]])
    result = retrieve(coordinator, text)
    assert [p.id for p in result.candidates] == [UUID(PRODUCT_A)]
    assert calls[0][0] == "get_products" and calls[1][0] == "get_product_details"
    assert all(c[2] == "fixture-a" for c in calls)


def test_specific_selectors_skip_catalog_download_and_deduplicate_detail_calls():
    coordinator, calls = setup()
    result = retrieve(coordinator, "T-Shirt details", product_ids=(PRODUCT_A, PRODUCT_A))
    assert [c[0] for c in calls] == ["get_product_details"]
    assert result.cache_hits == 1 and result.detail_lookups == result.backend_calls == 1
    assert len(result.candidates) == 1 and result.catalog_coverage == Coverage.NOT_SEARCHED


def test_explicit_variant_request_validates_parent_and_calls_only_requested_detail():
    coordinator, calls = setup()
    variant_id = PRODUCTS[0]["variants"][1]["id"]
    refs = ({"product_id": PRODUCT_A, "variant_id": variant_id},) * 2
    result = retrieve(coordinator, "price please", variant_references=refs)
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]
    assert result.cache_hits == 2 and result.detail_lookups == 2
    assert result.variants[0].id == UUID(variant_id)
    assert result.variants[0].inventory_state == InventoryState.RECORDED_ZERO
    assert result.variant_coverage[0].coverage == Coverage.PARTIAL


def test_actual_option_combination_triggers_variant_detail_without_cartesian_inference():
    coordinator, calls = setup()
    result = retrieve(coordinator, "is black size M available?", product_ids=(PRODUCT_A,))
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]
    assert result.variants[0].optionValues == {"color": "Black", "size": "M"}
    coordinator, calls = setup()
    missing = retrieve(coordinator, "is blue size L available?", product_ids=(PRODUCT_A,))
    assert missing.variants == () and [c[0] for c in calls] == ["get_product_details"]
    assert "no_verified_matching_variant" in missing.issues


def test_active_actual_variants_retain_distinct_prices_and_inventory_not_guarantees():
    coordinator, calls = setup()
    result = retrieve(coordinator, "how much is it?", product_ids=(PRODUCT_A,))
    assert [v.inventory_state for v in result.variants[:3]] == [
        InventoryState.RECORDED_POSITIVE, InventoryState.RECORDED_ZERO, InventoryState.UNTRACKED]
    assert all(v.isActive for v in result.variants)
    assert len(result.variants) == 4  # inactive White/L excluded, not an invented combination
    assert [str(v.effectivePrice) for v in result.variants[:3]] == ["250.00", "200.00", "225.00"]
    assert [c[0] for c in calls] == ["get_product_details"]


def test_inactive_parent_never_yields_variants_even_with_explicit_variant_selector():
    product = PRODUCTS[1]
    coordinator, calls = setup()
    result = retrieve(coordinator, "price", variant_references=({"product_id": product["id"], "variant_id": product["variants"][0]["id"]},))
    assert result.candidates == result.variants == ()
    assert [c[0] for c in calls] == ["get_product_details"] and "inactive_product" in result.issues


def test_explicit_inactive_variant_is_evidence_but_not_an_active_candidate():
    coordinator, calls = setup()
    result = retrieve(coordinator, "price", variant_references=({
        "product_id": PRODUCT_A, "variant_id": PRODUCTS[0]["variants"][3]["id"]},))
    assert result.variants == () and "inactive_variant" in result.issues
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]
    assert result.evidence[-1].envelope.data.isActive is False


def test_null_variant_price_is_not_replaced_or_inferred_from_sellability():
    product = PRODUCTS[2]
    coordinator, calls = setup()
    result = retrieve(coordinator, "how much is it?", product_ids=(product["id"],))
    assert result.variants[0].effectivePrice is None
    assert result.variants[0].inventory_state == InventoryState.UNTRACKED
    assert result.candidates[0].isSellable is False
    assert [c[0] for c in calls] == ["get_product_details"]


def test_refreshed_variant_no_longer_matching_options_is_not_silently_substituted():
    def handler(request, method, args, count):
        if method == "get_variant_details":
            variant = deepcopy(PRODUCTS[0]["variants"][0])
            variant["optionValues"] = {"color": "White", "size": "L"}
            return httpx.Response(200, json={"tool": method, "data": variant})
    coordinator, calls = setup(handler=handler)
    result = retrieve(coordinator, "is black size M available?", product_ids=(PRODUCT_A,))
    assert result.variants == () and result.needs_clarification
    assert "variant_options_mismatch" in result.issues and len(calls) == 2


@pytest.mark.parametrize("keys,text", [
    (("Color", "Size"), "is black size M available?"),
    (("لون", "مقاس"), "عايز تيشيرت أسود مقاس M"),
    (("Material", "Configuration"), "Material: Cotton, Configuration: Pro"),
])
def test_dynamic_business_option_keys_use_actual_records_in_retrieval(keys, text):
    product = deepcopy(PRODUCTS[0])
    material = keys[0] == "Material"
    product["options"] = {keys[0]: ["Cotton", "Wool"] if material else ["Black", "White"],
                          keys[1]: ["Pro", "Standard"] if material else ["M", "L"]}
    product["variants"] = product["variants"][:2]
    for index, variant in enumerate(product["variants"]):
        variant["optionValues"] = {keys[0]: "Cotton" if material else "Black",
                                   keys[1]: ("Pro" if index == 0 else "Standard") if material else ("M" if index == 0 else "L")}
    product["variantsPagination"]["totalCount"] = 2
    coordinator, calls = setup([product])
    result = retrieve(coordinator, text, product_ids=(PRODUCT_A,))
    assert [v.id for v in result.variants] == [UUID(product["variants"][0]["id"])]
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]
    assert all(c[2] == "fixture-a" for c in calls)


def test_unsupported_dynamic_option_value_in_retrieval_cannot_select_a_variant():
    product = deepcopy(PRODUCTS[0])
    product["options"] = {"Material": ["Cotton"]}
    product["variants"] = product["variants"][:1]
    product["variants"][0]["optionValues"] = {"Material": "Cotton"}
    product["variantsPagination"]["totalCount"] = 1
    coordinator, calls = setup([product])
    result = retrieve(coordinator, "Material: Silk", product_ids=(PRODUCT_A,))
    assert result.variants == () and "no_verified_matching_variant" in result.issues
    assert [c[0] for c in calls] == ["get_product_details"]


def test_ambiguous_products_are_not_silently_resolved_or_fanned_out_into_variants():
    other = deepcopy(PRODUCTS[0])
    other["id"] = PRODUCTS[2]["id"]
    other["name"] = "Classic T-Shirt"
    other["variants"] = []
    other["variantsPagination"].update(totalCount=0)
    coordinator, calls = setup([PRODUCTS[0], other])
    result = retrieve(coordinator, "how much is the T-Shirt?")
    assert len(result.candidates) == 2 and result.needs_clarification
    assert [c[0] for c in calls] == ["get_products"]


@pytest.mark.parametrize("products,limits,coverage,status", [
    ([], RetrievalLimits(), Coverage.EXHAUSTED, Status.EMPTY),
    ([PRODUCTS[2]], RetrievalLimits(), Coverage.EXHAUSTED, Status.EMPTY),
    ([PRODUCTS[2], PRODUCTS[0]], RetrievalLimits(max_product_pages=1, page_size=1), Coverage.PARTIAL, Status.PARTIAL),
])
def test_empty_page_no_match_and_incomplete_search_are_distinct(products, limits, coverage, status):
    coordinator, _ = setup(products, limits=limits)
    result = retrieve(coordinator, "do you have a hoodie?")
    assert result.candidates == () and result.catalog_coverage == coverage and result.status == status


@pytest.mark.parametrize("limits,issue,max_calls", [
    (RetrievalLimits(max_calls=1), "call_limit", 1),
    (RetrievalLimits(max_detail_lookups=1), "detail_limit", 1),
    (RetrievalLimits(max_records=1), "record_limit", 1),
])
def test_budgets_prevent_further_calls(limits, issue, max_calls):
    coordinator, calls = setup(limits=limits)
    result = retrieve(coordinator, "price", variant_references=({"product_id": PRODUCT_A, "variant_id": PRODUCTS[0]["variants"][0]["id"]},))
    assert issue in result.issues and len(calls) <= max_calls
    assert result.records_inspected <= limits.max_records


def test_partial_embedded_variant_page_uses_only_supported_variant_pagination():
    full = deepcopy(PRODUCTS[0])
    def handler(request, method, args, count):
        if method == "get_product_details":
            product = deepcopy(full)
            product["variants"] = product["variants"][:2]
            product["variantsPagination"].update(limit=2, hasMore=True, nextOffset=2)
            return httpx.Response(200, json={"tool": method, "data": product})
    coordinator, calls = setup(handler=handler, limits=RetrievalLimits(page_size=2))
    result = retrieve(coordinator, "how much is it?", product_ids=(PRODUCT_A,))
    assert [c[0] for c in calls] == ["get_product_details", "get_product_variants", "get_product_variants"]
    assert [c[1]["offset"] for c in calls[1:]] == [2, 4]
    assert result.variant_coverage[0].coverage == Coverage.EXHAUSTED and len(result.variants) == 4


def test_variant_pagination_is_also_stopped_by_total_call_budget():
    def handler(request, method, args, count):
        if method == "get_product_details":
            product = deepcopy(PRODUCTS[0])
            product["variants"] = []
            product["variantsPagination"].update(hasMore=True, nextOffset=1)
            return httpx.Response(200, json={"tool": method, "data": product})
        if method == "get_product_variants":
            return httpx.Response(200, json={"tool": method, "data": {"items": [], "pagination": {
                "limit": args["limit"], "offset": args["offset"], "totalCount": 100,
                "hasMore": True, "nextOffset": args["offset"] + 1}}})
    coordinator, calls = setup(handler=handler, limits=RetrievalLimits(max_calls=3))
    result = retrieve(coordinator, "price", product_ids=(PRODUCT_A,))
    assert len(calls) == 3 and "call_limit" in result.issues
    assert result.variant_coverage[0].coverage == Coverage.PARTIAL


def test_history_references_are_bound_revalidated_deduplicated_and_never_confirmed():
    coordinator, calls = setup()
    prior = history((PRODUCT_A, None), (PRODUCT_A, None))
    result = retrieve(coordinator, "yes", history=prior, history_scope=SCOPE)
    assert [c[0] for c in calls] == ["get_product_details"] and result.cache_hits == 1
    assert result.needs_clarification and "provisional_history_references" in result.issues
    assert result.candidates[0].name == "Cotton T-Shirt"


@pytest.mark.parametrize("text", ["yes", "منه", "نفس المقاس", "عايزة اتنين"])
def test_unresolved_followup_without_history_never_retrieves_or_confirms(text):
    coordinator, calls = setup()
    result = retrieve(coordinator, text)
    assert result.decision == Decision.CLARIFY and calls == []


def test_historical_hint_does_not_override_self_contained_current_question():
    coordinator, calls = setup()
    result = retrieve(coordinator, "how much is the T-Shirt?", history=history((PRODUCTS[2]["id"], None)), history_scope=SCOPE)
    assert result.candidates[0].id == UUID(PRODUCT_A)
    assert not any(c[1].get("productId") == PRODUCTS[2]["id"] for c in calls)


@pytest.mark.parametrize("history_scope,failure", [(None, None),
    (ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_B, conversation_id=CONVERSATION_B), None),
    (SCOPE, Status.AUTHORIZATION_FAILED)])
def test_unbound_cross_customer_or_unauthorized_history_fails_closed(history_scope, failure):
    coordinator, calls = setup()
    result = retrieve(coordinator, "yes", history=history((PRODUCT_A, None), failure=failure), history_scope=history_scope)
    assert result.status in {Status.SCOPE_MISMATCH, Status.AUTHORIZATION_FAILED}
    assert result.evidence == result.candidates == () and calls == []


def test_history_authorization_failure_stops_even_a_self_contained_protected_inquiry():
    coordinator, calls = setup()
    result = retrieve(coordinator, "how much is the T-Shirt?", history=history(failure=Status.AUTHORIZATION_FAILED), history_scope=SCOPE)
    assert result.status == Status.AUTHORIZATION_FAILED and calls == []


@pytest.mark.parametrize("failure", [401, 403, "scope"])
def test_auth_scope_failure_after_success_discards_all_evidence_and_stops(failure):
    def handler(request, method, args, count):
        if count == 2:
            if failure == "scope":
                variant = deepcopy(PRODUCTS[0]["variants"][0])
                variant["businessId"] = BUSINESS_B
                return httpx.Response(200, json={"tool": method, "data": variant})
            return httpx.Response(failure, text="PRIVATE fixture-a")
    coordinator, calls = setup(handler=handler)
    refs = ({"product_id": PRODUCT_A, "variant_id": PRODUCTS[0]["variants"][0]["id"]},)
    result = retrieve(coordinator, "price", variant_references=refs)
    assert len(calls) == 2 and result.status in {Status.AUTHORIZATION_FAILED, Status.SCOPE_MISMATCH}
    assert result.evidence == result.candidates == result.variants == ()
    assert "PRIVATE" not in repr(result) and "fixture-a" not in repr(result)


@pytest.mark.parametrize("failure", [404, 503, "timeout", "invalid"])
def test_missing_invalid_or_unavailable_details_preserve_only_partial_prior_evidence(failure):
    def handler(request, method, args, count):
        if method == "get_product_details":
            if failure == "timeout":
                raise httpx.ReadTimeout("PRIVATE fixture-a", request=request)
            if failure == "invalid":
                return httpx.Response(200, json={"tool": method, "data": {}})
            return httpx.Response(failure)
    coordinator, calls = setup(handler=handler)
    result = retrieve(coordinator, "how much is the T-Shirt?")
    assert [c[0] for c in calls] == ["get_products", "get_product_details"]
    assert result.status == Status.PARTIAL and result.failure in {Status.UNAVAILABLE, Status.INVALID}
    assert len(result.evidence) == 1


def test_deadline_cancels_slow_data_access_and_keeps_no_state():
    class Slow:
        async def get_products(self, *args, **kwargs):
            await asyncio.sleep(1)
            pytest.fail("Must be cancelled")
    # Isolate await cancellation from incidental CPU/scheduler time in routing.
    # wait_for still enforces the real 1ms timeout on the slow data-access call.
    coordinator = RetrievalCoordinator(Slow(), RetrievalLimits(max_elapsed_seconds=0.001), clock=lambda: 0.0)
    result = retrieve(coordinator)
    assert result.status == Status.UNAVAILABLE and result.backend_calls == 1 and "timeout" in result.issues
    assert set(vars(coordinator)) == {"_data", "_limits", "_clock"}


def test_identical_queries_in_separate_executions_do_not_share_cache():
    coordinator, calls = setup()
    first = retrieve(coordinator, "details", product_ids=(PRODUCT_A,))
    second = retrieve(coordinator, "details", product_ids=(PRODUCT_A,))
    assert len(calls) == 2 and first.backend_calls == second.backend_calls == 1
    assert first.cache_hits == second.cache_hits == 0
    assert first.candidates[0] is not second.candidates[0]


def test_injection_inside_prepared_history_text_is_not_interpreted_as_tool_policy():
    from app.data.history import HistoryTurn
    prior = PreparedHistory(HistoryCoverage.PARTIAL, messages=(
        HistoryTurn("history", "OWNER", ATTACK + f" businessId={BUSINESS_B}", "TEXT", None, None),),
        references=history((PRODUCT_A, None)).references)
    coordinator, calls = setup()
    result = retrieve(coordinator, "منه", history=prior, history_scope=SCOPE)
    assert [c[0] for c in calls] == ["get_product_details"]
    assert all(c[2] == "fixture-a" for c in calls)
    assert result.candidates[0].businessId == UUID(BUSINESS_A) and result.needs_clarification


def test_description_and_historical_injection_cannot_control_scope_tools_or_prices():
    product = deepcopy(PRODUCTS[0])
    product["description"] = ATTACK + f" businessId={BUSINESS_B} https://evil.test"
    coordinator, calls = setup([product])
    result = retrieve(coordinator, "how much is the T-Shirt?")
    assert all(c[0] in {"get_products", "get_product_details"} for c in calls)
    assert all(c[2] == "fixture-a" for c in calls)
    assert str(result.variants[0].effectivePrice) == "250.00"
    assert ATTACK not in repr(result)
    coordinator, calls = setup([product])
    prior = history((PRODUCT_A, None))
    result = retrieve(coordinator, "منه", history=prior, history_scope=SCOPE)
    assert [c[0] for c in calls] == ["get_product_details"]
    assert result.needs_clarification


@pytest.mark.parametrize("same_business", [True, False])
def test_concurrent_customers_have_separate_call_budgets_cache_and_scope(same_business):
    async def run():
        calls = []
        class Data:
            async def get_product_details(self, product_id, *, scope, context_token):
                await asyncio.sleep(0)
                calls.append((product_id, scope, context_token))
                product = deepcopy(PRODUCTS[0])
                product["businessId"] = str(scope.business_id)
                for variant in product["variants"]:
                    variant["businessId"] = str(scope.business_id)
                # Use real typed access for normalization and scope validation.
                adapter = BackendDataAccess(BackendClient("https://backend.test", "fixture-service", transport=httpx.MockTransport(
                    lambda r: httpx.Response(200, json={"tool": "get_product_details", "data": product}))))
                return await adapter.get_product_details(product_id, scope=scope, context_token=context_token)
        other = ExpectedScope(business_id=BUSINESS_A if same_business else BUSINESS_B, customer_id=CUSTOMER_B, conversation_id=CONVERSATION_B)
        coordinator = RetrievalCoordinator(Data())
        query = RetrievalQuery(text="details", product_ids=(PRODUCT_A, PRODUCT_A))
        first, second = await asyncio.gather(
            coordinator.retrieve(query, scope=SCOPE, context_token="fixture-a"),
            coordinator.retrieve(query, scope=other, context_token="fixture-b"))
        assert first.backend_calls == second.backend_calls == first.cache_hits == second.cache_hits == 1
        assert len(calls) == 2 and set(c[2] for c in calls) == {"fixture-a", "fixture-b"}
        assert calls[0][1] == SCOPE and calls[1][1] == other
        first.candidates[0].attributes["material"] = "changed"
        assert second.candidates[0].attributes["material"] == "Cotton"
        assert set(vars(coordinator)) == {"_data", "_limits", "_clock"}
    asyncio.run(run())


@pytest.mark.parametrize("kwargs", [{"max_calls": 0}, {"max_product_pages": True}, {"max_records": -1},
    {"max_detail_lookups": 1.5}, {"page_size": 101}, {"max_elapsed_seconds": float("inf")},
    {"max_elapsed_seconds": False}])
def test_invalid_limits_rejected(kwargs):
    with pytest.raises(ValueError):
        RetrievalLimits(**kwargs)
