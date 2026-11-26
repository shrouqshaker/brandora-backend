"""Standalone typed evidence and scope checks using synthetic mocked responses."""
import asyncio
from copy import deepcopy
from decimal import Decimal
import json
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.clients.backend_client import BackendClient
from app.data.backend import BackendDataAccess
from app.schemas.backend import (
    APPLICATION_CURRENCY, ExpectedScope, InventoryState, Product, ProductVariant,
    RetrievalStatus as Status,
)
from tests.backend_contract_fixtures import (
    BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B, CONVERSATION_A, CONVERSATION_B,
    PRODUCTS, PRODUCT_A, tool_examples,
)

SCOPE = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_A, conversation_id=CONVERSATION_A)


def access(handler):
    return BackendDataAccess(BackendClient("https://backend.test", "fixture-service",
                                          transport=httpx.MockTransport(handler)))


def detail(raw):
    return asyncio.run(access(lambda r: httpx.Response(200, json={"tool": "get_product_details", "data": raw})).get_product_details(
        UUID(PRODUCT_A), scope=SCOPE, context_token="fixture-customer-a"))


@pytest.mark.parametrize("example", tool_examples(), ids=lambda e: e["tool"])
def test_all_six_methods_use_existing_wire_contract_and_typed_full_envelope(example):
    def handler(request):
        assert request.headers["Authorization"] == "Bearer fixture-service"
        assert request.headers["X-AI-Context"] == "fixture-customer-a"
        assert json.loads(request.content) == {"tool": example["tool"], "arguments": example["arguments"]}
        return httpx.Response(200, json={"tool": example["tool"], "data": example["data"]})
    arguments = {"productId": "product_id", "variantId": "variant_id", "conversationId": "conversation_id"}
    kwargs = {arguments.get(k, k): v for k, v in example["arguments"].items()}
    result = asyncio.run(getattr(access(handler), example["tool"])(**kwargs, scope=SCOPE, context_token="fixture-customer-a"))
    assert result.error is None and result.envelope.tool == example["tool"]
    assert result.status == (Status.PARTIAL if example["tool"] in {
        "get_products", "get_product_details", "get_product_variants"} else Status.AVAILABLE)
    if example["tool"] == "get_product_details":
        assert isinstance(result.envelope.data, Product)
        assert result.envelope.data.id == UUID(PRODUCT_A)
    if example["tool"] == "get_conversation_history":
        assert [m.id for m in result.envelope.data.items] == [m["id"] for m in example["data"]["items"]]
        assert "OWNER" in [m.senderType for m in result.envelope.data.items]


@pytest.mark.parametrize("price", ["0.00", "0.01", "9999999999.98", "9999999999.99"])
def test_price_precision_null_zero_currency_and_authoritative_effective_price(price):
    product = deepcopy(PRODUCTS[0])
    product["variants"][0]["effectivePrice"] = price
    product["variants"][0]["unitPrice"] = price
    result = detail(product)
    assert result.status == Status.AVAILABLE
    data = result.envelope.data
    assert data.variants[0].effectivePrice == Decimal(price)
    assert data.variants[4].effectivePrice == Decimal("0.00")
    assert data.variants[1].unitPrice is None
    product["variants"][0]["effectivePrice"] = None
    assert detail(product).envelope.data.variants[0].effectivePrice is None
    assert APPLICATION_CURRENCY == "EGP"
    assert "currency" not in Product.model_fields
    assert data.model_dump(mode="json")["variants"][0]["effectivePrice"] == price


@pytest.mark.parametrize("value", [1, 1.25, True, "1", "1.2", "1.234", "NaN", "Infinity", "-1.00", "1e2", " 1.00"])
def test_malformed_prices_are_not_converted_to_customer_facts(value):
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0]["effectivePrice"] = value
    result = detail(raw)
    assert result.status == Status.INVALID and result.envelope is None


def test_inventory_and_activity_are_preserved_not_interpreted_as_guaranteed_availability():
    product = detail(PRODUCTS[0]).envelope.data
    assert [v.inventory_state for v in product.variants[:3]] == [
        InventoryState.RECORDED_POSITIVE, InventoryState.RECORDED_ZERO, InventoryState.UNTRACKED]
    assert product.isSellable and product.variants[1].stockQuantity == 0
    assert product.variants[3].isActive is False
    inactive = Product.model_validate(PRODUCTS[1])
    assert not inactive.isActive and inactive.variants[0].isActive
    unpriced = Product.model_validate(PRODUCTS[2])
    assert unpriced.variants[0].effectivePrice is None and not unpriced.isSellable
    # Options must not generate extra variants: Blue/L never appears.
    assert len(product.variants) == 5
    assert not any(v.optionValues == {"color": "Blue", "size": "L"} for v in product.variants)
    assert product.variants[0].effectivePrice == Decimal("250.00") and product.variants[0].stockQuantity == 5
    assert product.variants[1].effectivePrice == Decimal("200.00") and product.variants[1].stockQuantity == 0


def test_current_backend_product_id_alias_is_normalized_without_leaking_to_model():
    raw = deepcopy(PRODUCTS[0])
    for variant in raw["variants"]:
        variant["productId"] = variant.pop("catalogItemId")
    result = detail(raw)
    assert result.status == Status.AVAILABLE
    assert all(v.catalogItemId == UUID(PRODUCT_A) for v in result.envelope.data.variants)
    assert all("productId" not in v for v in result.envelope.data.model_dump(mode="json")["variants"])


def test_conflicting_product_id_aliases_are_invalid_not_silently_corrected():
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0]["productId"] = PRODUCTS[1]["id"]
    result = detail(raw)
    assert result.status == Status.INVALID and result.error == "invalid_response"


@pytest.mark.parametrize("field,value", [("stockQuantity", None), ("stockQuantity", -1), ("stockQuantity", True),
    ("stockQuantity", 1.0), ("stockQuantity", "5"), ("trackInventory", "false"), ("isActive", 1)])
def test_invalid_inventory_and_flags_are_rejected(field, value):
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0][field] = value
    assert detail(raw).status == Status.INVALID


def test_untracked_nonnull_inventory_is_invalid_not_available():
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][2]["stockQuantity"] = 5
    assert detail(raw).status == Status.INVALID


@pytest.mark.parametrize("field", ["basePrice", "unitPrice", "effectivePrice"])
@pytest.mark.parametrize("price", ["0.00", "0.01", "9999999999.99"])
def test_decimal_12_2_boundaries_apply_to_every_price_field(field, price):
    raw = deepcopy(PRODUCTS[0])
    raw["basePrice"] = price
    for variant in raw["variants"]:
        variant.update(unitPrice=price, effectivePrice=price)
    result = detail(raw)
    assert result.status == Status.AVAILABLE
    model = result.envelope.data if field == "basePrice" else result.envelope.data.variants[0]
    assert getattr(model, field) == Decimal(price)
    assert model.model_dump(mode="json")[field] == price


@pytest.mark.parametrize("field", ["basePrice", "unitPrice", "effectivePrice"])
@pytest.mark.parametrize("price", ["10000000000.00", "99999999999.99", "123456789012345678901234567890.12", "00000000000.00"])
def test_prices_exceeding_ten_integer_digits_are_invalid(field, price):
    raw = deepcopy(PRODUCTS[0])
    (raw if field == "basePrice" else raw["variants"][0])[field] = price
    with pytest.raises(ValidationError, match=r"Decimal\(12,2\)"):
        Product.model_validate(raw)
    result = detail(raw)
    assert result.status == Status.INVALID and result.error == "invalid_response" and result.envelope is None


@pytest.mark.parametrize("tracked,quantity", [(True, None), (False, 0), (False, 5)])
def test_contradictory_inventory_is_rejected_by_model_and_data_layer(tracked, quantity):
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0].update(trackInventory=tracked, stockQuantity=quantity)
    with pytest.raises(ValidationError):
        ProductVariant.model_validate(raw["variants"][0])
    result = detail(raw)
    assert result.status == Status.INVALID and result.error == "invalid_response" and result.envelope is None


@pytest.mark.parametrize("index", [0, 1])
def test_contradictory_nonnull_backend_price_is_invalid_never_silently_corrected(index):
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][index]["effectivePrice"] = "1.00"
    result = detail(raw)
    assert result.status == Status.INVALID and result.envelope is None


@pytest.mark.parametrize("field", list(PRODUCTS[0]))
def test_missing_required_product_fields_are_invalid(field):
    raw = deepcopy(PRODUCTS[0])
    del raw[field]
    assert detail(raw).status == Status.INVALID


@pytest.mark.parametrize("field", list(PRODUCTS[0]["variants"][0]))
def test_missing_required_variant_fields_are_invalid(field):
    raw = deepcopy(PRODUCTS[0])
    del raw["variants"][0][field]
    assert detail(raw).status == Status.INVALID


@pytest.mark.parametrize("target,field,value", [
    ("product", "businessId", BUSINESS_B), ("product", "id", PRODUCTS[1]["id"]),
    ("variant", "businessId", BUSINESS_B), ("variant", "catalogItemId", PRODUCTS[1]["id"]),
])
def test_detail_scope_and_parent_mismatches_fail_closed(target, field, value):
    raw = deepcopy(PRODUCTS[0])
    (raw if target == "product" else raw["variants"][0])[field] = value
    result = detail(raw)
    assert result.status == Status.SCOPE_MISMATCH and result.envelope is None


@pytest.mark.parametrize("field,value", [("businessId", BUSINESS_B),
    ("catalogItemId", PRODUCTS[1]["id"]), ("id", PRODUCTS[0]["variants"][1]["id"])])
def test_variant_detail_validates_all_relationships(field, value):
    raw = deepcopy(PRODUCTS[0]["variants"][0])
    raw[field] = value
    result = asyncio.run(access(lambda r: httpx.Response(200, json={"tool": "get_variant_details", "data": raw})).get_variant_details(
        PRODUCT_A, PRODUCTS[0]["variants"][0]["id"], scope=SCOPE, context_token="fixture-a"))
    assert result.status == Status.SCOPE_MISMATCH and result.envelope is None


@pytest.mark.parametrize("tool", ["get_products", "get_product_variants"])
def test_list_scope_failures_reject_entire_page(tool):
    example = next(e for e in tool_examples() if e["tool"] == tool)
    example["data"]["items"][1]["businessId"] = BUSINESS_B
    method = getattr(access(lambda r: httpx.Response(200, json={"tool": tool, "data": example["data"]})), tool)
    args = (PRODUCT_A, 2, 0) if tool == "get_product_variants" else (2, 0)
    result = asyncio.run(method(*args, scope=SCOPE, context_token="fixture-a"))
    assert result.status == Status.SCOPE_MISMATCH and result.envelope is None


@pytest.mark.parametrize("field,value", [("limit", True), ("limit", 101), ("hasMore", "false"),
    ("nextOffset", 0), ("nextOffset", 9007199254740992), ("totalCount", -1)])
def test_embedded_variant_pagination_is_validated_above_transport(field, value):
    raw = deepcopy(PRODUCTS[0])
    raw["variantsPagination"] = {"limit": 20, "offset": 0, "totalCount": 50, "hasMore": True, "nextOffset": 20}
    raw["variantsPagination"][field] = value
    assert detail(raw).status == Status.INVALID


def test_embedded_page_count_is_advisory_and_partial_is_explicit():
    raw = deepcopy(PRODUCTS[0])
    raw["variantsPagination"]["totalCount"] = 0  # separate count snapshot
    assert detail(raw).status == Status.AVAILABLE
    raw["variantsPagination"].update(hasMore=True, nextOffset=20)
    assert detail(raw).status == Status.PARTIAL
    raw["variantsPagination"]["limit"] = 1
    assert detail(raw).status == Status.INVALID


@pytest.mark.parametrize("status,expected", [(401, Status.AUTHORIZATION_FAILED), (403, Status.AUTHORIZATION_FAILED),
    (404, Status.UNAVAILABLE), (429, Status.UNAVAILABLE), (503, Status.UNAVAILABLE)])
def test_http_failures_are_distinct_and_never_retry_or_leak(status, expected):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, text="PRIVATE_CUSTOMER fixture-service fixture-a")
    result = asyncio.run(access(handler).get_product_details(PRODUCT_A, scope=SCOPE, context_token="fixture-a"))
    assert result.status == expected and result.envelope is None and len(calls) == 1
    assert "PRIVATE_CUSTOMER" not in str(result) and "fixture-a" not in result.model_dump_json()


def test_timeout_and_malformed_json_have_safe_distinct_outcomes():
    def timeout(request):
        raise httpx.ReadTimeout("PRIVATE_CUSTOMER fixture-a", request=request)
    timed = asyncio.run(access(timeout).get_products(scope=SCOPE, context_token="fixture-a"))
    assert timed.status == Status.UNAVAILABLE and timed.error == "timeout"
    malformed = asyncio.run(access(lambda r: httpx.Response(200, content=b"PRIVATE_CUSTOMER")).get_products(scope=SCOPE, context_token="fixture-a"))
    assert malformed.status == Status.INVALID and malformed.error == "invalid_response"
    assert "PRIVATE_CUSTOMER" not in str(timed) + str(malformed)


@pytest.mark.parametrize("raw", [{}, {"product": PRODUCTS[0]}, None, [], {"id": "private-secret"}])
def test_invalid_or_wrapped_detail_never_becomes_evidence(raw):
    result = detail(raw)
    assert result.status == Status.INVALID and result.envelope is None
    assert "private-secret" not in result.model_dump_json()


def test_business_aggregate_checks_scope_and_does_not_create_policy_defaults():
    def fetch(business):
        return asyncio.run(access(lambda r: httpx.Response(200, json={"tool": "get_business_info", "data": {"business": business}})).get_business_info(
            scope=SCOPE, context_token="fixture-a"))
    result = fetch({"id": BUSINESS_A, "name": "Fixture"})
    assert result.status == Status.AVAILABLE
    assert result.envelope.data.model_dump(mode="json") == {"business": {"id": BUSINESS_A, "name": "Fixture"}}
    assert fetch({"id": BUSINESS_B, "name": "Fixture"}).status == Status.SCOPE_MISMATCH
    assert fetch({"id": BUSINESS_A}).status == Status.INVALID


@pytest.mark.parametrize("scope,conversation", [
    (SCOPE, CONVERSATION_B), (ExpectedScope(business_id=BUSINESS_A), CONVERSATION_A),
])
def test_history_requires_matching_caller_scope_before_network(scope, conversation):
    def handler(request):
        pytest.fail("Mismatched or incomplete history scope must not send a request")
    result = asyncio.run(access(handler).get_conversation_history(conversation, scope=scope, context_token="fixture-a"))
    assert result.status == Status.SCOPE_MISMATCH


@pytest.mark.parametrize("same_business", [True, False])
def test_concurrent_scopes_tokens_and_nested_models_are_request_local(same_business):
    seen = []
    shared = deepcopy(PRODUCTS[0])
    class FakeClient:
        async def get_product_details(self, product_id, *, context_token):
            await asyncio.sleep(0)
            seen.append(context_token)
            # Return the same nested dict intentionally, to check ownership.
            return {"tool": "get_product_details", "data": shared}
    async def run():
        layer = BackendDataAccess(FakeClient())
        other = ExpectedScope(business_id=BUSINESS_A if same_business else BUSINESS_B, customer_id=CUSTOMER_B)
        first, second = await asyncio.gather(
            layer.get_product_details(PRODUCT_A, scope=SCOPE, context_token="fixture-a"),
            layer.get_product_details(PRODUCT_A, scope=other, context_token="fixture-b"))
        assert first.status == Status.AVAILABLE
        if same_business:
            assert second.status == Status.AVAILABLE
            first.envelope.data.variants[0].optionValues["color"] = "changed"
            assert second.envelope.data.variants[0].optionValues["color"] == "Black"
            assert shared["variants"][0]["optionValues"]["color"] == "Black"
        else:
            assert second.status == Status.SCOPE_MISMATCH and second.envelope is None
        assert set(vars(layer)) == {"_client"}
        assert "fixture-a" not in repr(first) and "fixture-b" not in repr(second)
    asyncio.run(run())
    assert sorted(seen) == ["fixture-a", "fixture-b"]


def test_two_businesses_retrieve_their_own_products_concurrently_with_no_cache():
    async def handler(request):
        await asyncio.sleep(0)
        token = request.headers["X-AI-Context"]
        product = PRODUCTS[0] if token == "fixture-a" else PRODUCTS[3]
        return httpx.Response(200, json={"tool": "get_product_details", "data": product})
    async def run():
        layer = access(handler)
        first, second = await asyncio.gather(
            layer.get_product_details(PRODUCT_A, scope=SCOPE, context_token="fixture-a"),
            layer.get_product_details(PRODUCTS[3]["id"], scope=ExpectedScope(business_id=BUSINESS_B, customer_id=CUSTOMER_B), context_token="fixture-b"))
        assert first.status == second.status == Status.AVAILABLE
        assert first.envelope.data.businessId == UUID(BUSINESS_A)
        assert second.envelope.data.businessId == UUID(BUSINESS_B)
        assert first.envelope.data.name == "Cotton T-Shirt"
        assert second.envelope.data.name == "Private Business B Scarf"
        assert set(vars(layer)) == {"_client"}
    asyncio.run(run())


def test_two_customers_history_evidence_is_separate_without_normalizing():
    async def handler(request):
        await asyncio.sleep(0)
        token = request.headers["X-AI-Context"]
        return httpx.Response(200, json={"tool": "get_conversation_history", "data": {
            "items": [{"senderType": "CUSTOMER", "content": "History A" if token == "fixture-a" else "History B"}],
            "pagination": {"limit": 20, "offset": 0, "totalCount": 1, "hasMore": False, "nextOffset": None}}})
    async def run():
        layer = access(handler)
        other = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_B, conversation_id=CONVERSATION_B)
        first, second = await asyncio.gather(
            layer.get_conversation_history(CONVERSATION_A, scope=SCOPE, context_token="fixture-a"),
            layer.get_conversation_history(CONVERSATION_B, scope=other, context_token="fixture-b"))
        assert first.envelope.data.items[0].content == "History A"
        assert second.envelope.data.items[0].content == "History B"
        assert first.envelope.data.items[0].createdAt is None
        assert "fixture-a" not in first.model_dump_json()
    asyncio.run(run())
