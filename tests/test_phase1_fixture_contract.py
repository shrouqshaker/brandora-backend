"""Fixture audits and mocked transport tests, NOT future pipeline acceptance.

No production variant planning, history normalization, token verification, or
Backend authorization is invoked or simulated as implemented AI behavior.
"""
import asyncio
from copy import deepcopy
from decimal import Decimal
import json
import re
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.clients.backend_client import (
    BackendAuthenticationError, BackendClient, BackendClientError, BackendTimeoutError,
)
from app.schemas import AiResponse
from tests.backend_contract_fixtures import (
    BUSINESS_A, BUSINESS_B, CONVERSATION_A, CONVERSATION_B, CUSTOMER_A, CUSTOMER_B,
    HISTORIES, PRODUCTS, PROPOSED_REQUEST, SCENARIOS, tool_examples,
)
from tests.helpers import VALIDATOR


@pytest.mark.parametrize("product", PRODUCTS, ids=lambda p: p["name"])
def test_catalog_fixture_matches_supplied_field_and_price_contract(product):
    assert set(product) == {
        "id", "businessId", "name", "description", "basePrice", "options", "attributes",
        "isActive", "isSellable", "variants", "variantsPagination",
    }
    UUID(product["id"])
    UUID(product["businessId"])
    prices = [product["basePrice"]]
    for variant in product["variants"]:
        assert set(variant) == {
            "id", "businessId", "catalogItemId", "optionValues", "unitPrice",
            "effectivePrice", "trackInventory", "stockQuantity", "isActive",
        }
        UUID(variant["id"])
        assert variant["businessId"] == product["businessId"]
        assert variant["catalogItemId"] == product["id"]
        # Audit synthetic Backend output; future Python must consume effectivePrice.
        assert variant["effectivePrice"] == (
            variant["unitPrice"] if variant["unitPrice"] is not None else product["basePrice"]
        )
        prices.extend([variant["unitPrice"], variant["effectivePrice"]])
        if variant["trackInventory"]:
            assert type(variant["stockQuantity"]) is int and variant["stockQuantity"] >= 0
        else:
            assert variant["stockQuantity"] is None
        for key, value in variant["optionValues"].items():
            assert value in product["options"][key]
    for price in prices:
        assert price is None or (re.fullmatch(r"\d+\.\d{2}", price) and Decimal(price).is_finite())
    assert "stockQuantity" not in product and "trackInventory" not in product
    assert "currency" not in product  # EGP is application policy, not a claimed DB field.
    assert product["isSellable"] == (product["isActive"] and any(
        v["isActive"] and v["effectivePrice"] is not None for v in product["variants"]
    ))


def test_catalog_examples_include_distinct_inventory_and_option_cases():
    product = PRODUCTS[0]
    variants = product["variants"]
    assert product["isSellable"] is True and variants[1]["stockQuantity"] == 0
    assert variants[0]["stockQuantity"] == 5 and variants[0]["effectivePrice"] == "250.00"
    assert variants[1]["effectivePrice"] == "200.00"
    assert variants[2]["trackInventory"] is False and variants[2]["stockQuantity"] is None
    assert variants[3]["isActive"] is False
    assert variants[4]["unitPrice"] == variants[4]["effectivePrice"] == "0.00"
    assert PRODUCTS[1]["isActive"] is False and PRODUCTS[1]["variants"][0]["isActive"] is True
    assert PRODUCTS[2]["variants"][0]["effectivePrice"] is None
    assert "Blue" in product["options"]["color"] and "L" in product["options"]["size"]
    assert not any(v["optionValues"] == {"color": "Blue", "size": "L"} for v in variants)


@pytest.mark.parametrize("name", HISTORIES)
def test_history_fixture_expectations_are_consistent_not_pipeline_results(name):
    example = HISTORIES[name]
    rows = example["rows"]
    assert all(set(row) == {"id", "senderType", "content", "messageType", "createdAt"} for row in rows)
    assert [r["createdAt"] for r in rows] == sorted([r["createdAt"] for r in rows], reverse=True)
    # Fixed examples use uniform UTC timestamps. This only audits the expectation
    # list; it is not the future history adapter or a test of its normalization.
    assert example["expectedPriorIds"] == [
        r["id"] for r in reversed(rows) if r["id"] != example["currentMessageId"]
    ]
    assert all(r["senderType"] in {"CUSTOMER", "AI", "OWNER"} for r in rows)


def test_history_fixture_retains_repeated_text_as_distinct_evidence():
    example = HISTORIES["arabic_reference"]
    assert example["rows"][-1]["content"] == example["rows"][-2]["content"]
    assert example["rows"][-1]["id"] != example["rows"][-2]["id"]
    assert len(example["expectedPriorIds"]) == 4
    assert {r["senderType"] for r in example["rows"]} == {"CUSTOMER", "AI", "OWNER"}


def test_canonical_request_fixture_has_exactly_five_v2_fields_and_string_message():
    assert set(PROPOSED_REQUEST) == {"businessId", "customerId", "conversationId", "messageId", "message"}
    assert isinstance(PROPOSED_REQUEST["message"], str) and PROPOSED_REQUEST["message"].strip()
    assert "schemaVersion" not in PROPOSED_REQUEST
    for key in ("businessId", "customerId", "conversationId", "messageId"):
        UUID(PROPOSED_REQUEST[key])
    assert PROPOSED_REQUEST["messageId"] == HISTORIES["arabic_reference"]["currentMessageId"]
    assert len({s["id"] for s in SCENARIOS}) == len(SCENARIOS)
    variants = {v["id"] for p in PRODUCTS for v in p["variants"]}
    for scenario in SCENARIOS:
        assert scenario["expected"].strip()
        if "variantId" in scenario:
            assert scenario["variantId"] in variants
        if "history" in scenario:
            assert scenario["history"] in HISTORIES


@pytest.mark.parametrize("example", tool_examples(), ids=lambda e: e["tool"])
def test_existing_client_transports_proposed_mock_envelopes(example):
    def handler(request):
        assert request.method == "POST" and request.url.path == "/internal/ai/data"
        assert request.headers["Authorization"] == "Bearer fixture-service-only"
        assert request.headers["X-AI-Context"] == "fixture-context-a-only"
        assert json.loads(request.content) == {"tool": example["tool"], "arguments": example["arguments"]}
        return httpx.Response(200, json={"tool": example["tool"], "data": example["data"]})
    backend = BackendClient("https://backend.test", "fixture-service-only", transport=httpx.MockTransport(handler))
    envelope = asyncio.run(backend.call_tool(example["tool"], example["arguments"], context_token="fixture-context-a-only"))
    assert envelope == {"tool": example["tool"], "data": example["data"]}
    if example["tool"] == "get_product_details":
        assert envelope["data"]["id"] == PRODUCTS[0]["id"]
        assert "product" not in envelope["data"]
    if example["tool"] == "get_variant_details":
        assert envelope["data"]["id"] == PRODUCTS[0]["variants"][0]["id"]
        assert "variant" not in envelope["data"]
    if example["tool"] == "get_products":
        assert envelope["data"]["pagination"]["hasMore"] is True
        assert envelope["data"]["items"][0]["variantsPagination"]["hasMore"] is True


@pytest.mark.parametrize("status", [401, 403, 404, 429, 503])
def test_client_failure_for_catalog_example_does_not_return_empty_catalog(status):
    example = tool_examples()[0]
    backend = BackendClient("https://backend.test", "fixture-service-only", transport=httpx.MockTransport(
        lambda request: httpx.Response(status, text="fixture-context-a-only")))
    expected = BackendAuthenticationError if status in {401, 403} else BackendClientError
    with pytest.raises(expected) as error:
        asyncio.run(backend.call_tool(example["tool"], example["arguments"], context_token="fixture-context-a-only"))
    assert "fixture-context" not in str(error.value)


def test_client_timeout_for_catalog_example_is_sanitized():
    def handler(request):
        raise httpx.ReadTimeout("fixture-context-a-only", request=request)
    backend = BackendClient("https://backend.test", "fixture-service-only", transport=httpx.MockTransport(handler))
    with pytest.raises(BackendTimeoutError, match="^Backend request timed out$"):
        asyncio.run(backend.get_products(context_token="fixture-context-a-only"))


def test_mock_history_requests_keep_customer_context_tokens_separate():
    seen = []
    async def handler(request):
        await asyncio.sleep(0)
        token = request.headers["X-AI-Context"]
        conversation = json.loads(request.content)["arguments"]["conversationId"]
        seen.append((token, conversation))
        # Mock 403 is a supplied outcome, not an implementation of authorization.
        if token == "fixture-customer-a" and conversation == CONVERSATION_B:
            return httpx.Response(403)
        return httpx.Response(200, json={"tool": "get_conversation_history", "data": {
            "items": [], "pagination": {"limit": 20, "offset": 0, "totalCount": 0,
                                          "hasMore": False, "nextOffset": None}}})
    async def run():
        backend = BackendClient("https://backend.test", "fixture-service-only", transport=httpx.MockTransport(handler))
        await asyncio.gather(
            backend.get_conversation_history(CONVERSATION_A, context_token="fixture-customer-a"),
            backend.get_conversation_history(CONVERSATION_B, context_token="fixture-customer-b"),
        )
        with pytest.raises(BackendAuthenticationError):
            await backend.get_conversation_history(CONVERSATION_B, context_token="fixture-customer-a")
    asyncio.run(run())
    assert set(seen) == {("fixture-customer-a", CONVERSATION_A),
                         ("fixture-customer-b", CONVERSATION_B), ("fixture-customer-a", CONVERSATION_B)}
    assert BUSINESS_A != BUSINESS_B and CUSTOMER_A != CUSTOMER_B


@pytest.mark.parametrize("intent", ["INQUIRY", "PURCHASE_INTENT", "OTHER"])
def test_proposed_read_only_reply_fits_existing_response_schema(intent):
    body = {"intent": intent, "reply": "Which product do you mean?", "requiresReview": False, "orderCandidate": None}
    VALIDATOR.validate(body)
    assert AiResponse.model_validate(body).orderCandidate is None
    invalid = deepcopy(body)
    invalid["intent"] = "CONFIRMED_ORDER"
    with pytest.raises(ValidationError):
        AiResponse.model_validate(invalid)
