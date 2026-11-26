import asyncio
import copy
import json

import httpx
import pytest

from app.clients.backend_client import (
    BackendAuthenticationError, BackendClient, BackendClientError,
    BackendResponseError, BackendTimeoutError,
)

PRODUCT_ID = "550e8400-e29b-41d4-a716-446655440000"
VARIANT_ID = "550e8400-e29b-41d4-a716-446655440001"
CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440002"


def page(limit=20, offset=0):
    return {"items": [], "pagination": {
        "limit": limit, "offset": offset, "totalCount": 0,
        "hasMore": False, "nextOffset": None,
    }}


def client(handler):
    return BackendClient("https://backend.test", "service-secret",
                         transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("method,args,arguments", [
    ("get_products", (), {"limit": 20, "offset": 0}),
    ("get_product_details", (PRODUCT_ID,), {"productId": PRODUCT_ID}),
    ("get_product_variants", (PRODUCT_ID, 5, 10), {"productId": PRODUCT_ID, "limit": 5, "offset": 10}),
    ("get_variant_details", (PRODUCT_ID, VARIANT_ID), {"productId": PRODUCT_ID, "variantId": VARIANT_ID}),
    ("get_conversation_history", (CONVERSATION_ID, 5, 10), {"conversationId": CONVERSATION_ID, "limit": 5, "offset": 10}),
    ("get_business_info", (), {}),
])
def test_operations(method, args, arguments):
    data = page(arguments["limit"], arguments["offset"]) if "limit" in arguments else {"id": "example"}
    envelope = {"tool": method, "data": data}

    def handler(request):
        assert request.method == "POST"
        assert str(request.url) == "https://backend.test/internal/ai/data"
        assert request.headers["Authorization"] == "Bearer service-secret"
        assert request.headers["X-AI-Context"] == "customer-secret"
        assert request.extensions["timeout"]["read"] == 10.0
        assert json.loads(request.content) == {"tool": method, "arguments": arguments}
        return httpx.Response(200, json=envelope)

    assert asyncio.run(getattr(client(handler), method)(*args, context_token="customer-secret")) == envelope


@pytest.mark.parametrize("tool,arguments", [
    ("create_order", {}), ("get_business_info", {"extra": 1}),
    ("get_product_details", {}), ("get_product_details", {"productId": " "}),
    ("get_variant_details", {"productId": PRODUCT_ID, "variantId": 1}),
    ("get_product_details", {"product_id": PRODUCT_ID}),
    ("get_product_variants", {"product_id": PRODUCT_ID}),
    ("get_variant_details", {"productId": PRODUCT_ID, "variant_id": VARIANT_ID}),
    ("get_conversation_history", {"conversation_id": CONVERSATION_ID}),
    ("get_products", {"limit": True}), ("get_products", {"limit": 0}),
    ("get_products", {"offset": -1}), ("get_products", {"offset": 1.5}),
    ("get_products", []),
])
def test_invalid_arguments_never_send(tool, arguments):
    def handler(request):
        pytest.fail("Invalid arguments must not reach transport")
    with pytest.raises(ValueError):
        asyncio.run(client(handler).call_tool(tool, arguments, context_token="ctx"))


@pytest.mark.parametrize("body", [None, [], {}, {"tool": "wrong", "data": {}},
    {"tool": "get_products", "data": []}, {"tool": "get_products", "data": {}}])
def test_invalid_envelopes(body):
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json=body)).get_products(context_token="ctx"))


def test_invalid_json():
    with pytest.raises(BackendResponseError, match="invalid JSON"):
        asyncio.run(client(lambda r: httpx.Response(200, content=b"not json")).get_business_info(context_token="ctx"))


def test_response_byte_cap_rejects_oversized_content_length_before_json_decode():
    envelope = json.dumps({"tool": "get_business_info", "data": {}}).encode()
    backend = BackendClient("https://backend.test", "service-secret", max_response_bytes=8,
                            transport=httpx.MockTransport(lambda request: httpx.Response(
                                200, content=envelope, headers={"Content-Length": str(len(envelope))})))
    with pytest.raises(BackendResponseError, match="byte limit"):
        asyncio.run(backend.get_business_info(context_token="ctx"))


def test_response_byte_cap_streams_when_content_length_is_missing():
    envelope = {"tool": "get_business_info", "data": {}}
    body = json.dumps(envelope).encode()
    backend = BackendClient("https://backend.test", "service-secret", max_response_bytes=len(body),
                            transport=httpx.MockTransport(lambda request: httpx.Response(
                                200, content=body, headers={"Content-Type": "application/json"})))
    assert asyncio.run(backend.get_business_info(context_token="ctx")) == envelope


@pytest.mark.parametrize("headers", [{"Content-Length": "not-a-number"}, {"Content-Length": "1"}])
def test_wrong_content_length_is_a_sanitized_response_error(headers):
    body = b'{"tool":"get_business_info","data":{}}'
    backend = BackendClient("https://backend.test", "service-secret", max_response_bytes=1024,
                            transport=httpx.MockTransport(lambda request: httpx.Response(
                                200, content=body, headers=headers)))
    with pytest.raises(BackendResponseError, match="response length"):
        asyncio.run(backend.get_business_info(context_token="ctx"))


@pytest.mark.parametrize("field,value", [
    ("limit", True), ("limit", 19), ("offset", 1), ("totalCount", -1),
    ("hasMore", "false"), ("nextOffset", 20),
])
def test_invalid_pagination(field, value):
    data = page()
    data["pagination"][field] = value
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json={"tool": "get_products", "data": data})).get_products(context_token="ctx"))


def test_multiple_pages_and_argument_copy():
    arguments = {"limit": 2, "offset": 0}
    original = copy.deepcopy(arguments)
    def handler(request):
        args = json.loads(request.content)["arguments"]
        offset = args["offset"]
        return httpx.Response(200, json={"tool": "get_products", "data": {
            "items": [{"id": index} for index in range(offset, min(offset + 2, 3))], "pagination": {
                "limit": 2, "offset": offset, "totalCount": 3,
                "hasMore": offset == 0, "nextOffset": 2 if offset == 0 else None,
            }}})
    async def run():
        backend = client(handler)
        first = await backend.call_tool("get_products", arguments, context_token="ctx")
        second = await backend.get_products(2, first["data"]["pagination"]["nextOffset"], context_token="ctx")
        assert second["data"]["pagination"]["hasMore"] is False
    asyncio.run(run())
    assert arguments == original


@pytest.mark.parametrize("status", [301, 401, 403, 404, 429, 500])
def test_http_errors_are_sanitized(status):
    expected = BackendAuthenticationError if status in {401, 403} else BackendClientError
    with pytest.raises(expected) as error:
        asyncio.run(client(lambda r: httpx.Response(status, text="service-secret customer-secret", headers={"Location": "https://elsewhere.test"})).get_business_info(context_token="customer-secret"))
    assert "secret" not in str(error.value)
    assert error.value.__suppress_context__ or error.value.__context__ is None


@pytest.mark.parametrize("exception,expected", [
    (httpx.ReadTimeout, BackendTimeoutError), (httpx.ConnectTimeout, BackendTimeoutError),
    (httpx.ConnectError, BackendClientError),
])
def test_transport_failures_are_sanitized(exception, expected):
    def handler(request):
        raise exception("service-secret customer-secret", request=request)
    with pytest.raises(expected) as error:
        asyncio.run(client(handler).get_business_info(context_token="customer-secret"))
    assert "secret" not in str(error.value)
    assert error.value.__suppress_context__


def test_concurrent_context_isolation():
    seen = []
    async def handler(request):
        await asyncio.sleep(0)
        seen.append(request.headers["X-AI-Context"])
        return httpx.Response(200, json={"tool": "get_business_info", "data": {}})
    async def run():
        backend = client(handler)
        await asyncio.gather(*(backend.get_business_info(context_token=token) for token in ["customer-a", "customer-b"]))
        with pytest.raises(TypeError):
            await backend.get_business_info()
        with pytest.raises(ValueError):
            await backend.get_business_info(context_token="")
    asyncio.run(run())
    assert sorted(seen) == ["customer-a", "customer-b"]


@pytest.mark.parametrize("kwargs", [
    {"base_url": "bad"}, {"base_url": "https://user:secret@backend.test"},
    {"base_url": "https://backend.test/path"}, {"service_token": ""},
    {"service_token": "bad\r\nheader"}, {"timeout": 0}, {"timeout": float("nan")},
])
def test_configuration_validation(kwargs):
    config = {"base_url": "https://backend.test", "service_token": "secret"}
    config.update(kwargs)
    with pytest.raises(ValueError):
        BackendClient(**config)


@pytest.mark.parametrize("method,kwargs,wire", [
    ("get_product_details", {"product_id": PRODUCT_ID}, {"productId": PRODUCT_ID}),
    ("get_product_variants", {"product_id": PRODUCT_ID}, {"productId": PRODUCT_ID, "limit": 20, "offset": 0}),
    ("get_variant_details", {"product_id": PRODUCT_ID, "variant_id": VARIANT_ID}, {"productId": PRODUCT_ID, "variantId": VARIANT_ID}),
    ("get_conversation_history", {"conversation_id": CONVERSATION_ID}, {"conversationId": CONVERSATION_ID, "limit": 20, "offset": 0}),
])
def test_python_keyword_parameters_and_direct_wire_arguments(method, kwargs, wire):
    def handler(request):
        assert json.loads(request.content) == {"tool": method, "arguments": wire}
        return httpx.Response(200, json={"tool": method, "data": page() if "limit" in wire else {}})
    async def run():
        backend = client(handler)
        await getattr(backend, method)(**kwargs, context_token="ctx")
        await backend.call_tool(method, wire, context_token="ctx")
    asyncio.run(run())


@pytest.mark.parametrize("tool,ids,key", [
    ("get_product_details", {"productId": PRODUCT_ID}, "productId"),
    ("get_product_variants", {"productId": PRODUCT_ID}, "productId"),
    ("get_variant_details", {"productId": PRODUCT_ID, "variantId": VARIANT_ID}, "productId"),
    ("get_variant_details", {"productId": PRODUCT_ID, "variantId": VARIANT_ID}, "variantId"),
    ("get_conversation_history", {"conversationId": CONVERSATION_ID}, "conversationId"),
])
@pytest.mark.parametrize("bad_id", [
    "not-a-uuid", "", None, 123, True,
    "550e8400e29b41d4a716446655440000",
    "{550e8400-e29b-41d4-a716-446655440000}",
    " 550e8400-e29b-41d4-a716-446655440000",
])
def test_uuid_validation_for_every_identifier(tool, ids, key, bad_id):
    def handler(request):
        pytest.fail("Invalid UUID must not reach transport")
    with pytest.raises(ValueError, match="UUID"):
        asyncio.run(client(handler).call_tool(tool, {**ids, key: bad_id}, context_token="ctx"))


@pytest.mark.parametrize("tool,ids", [
    ("get_products", {}), ("get_product_variants", {"productId": PRODUCT_ID}),
    ("get_conversation_history", {"conversationId": CONVERSATION_ID}),
])
@pytest.mark.parametrize("key,value", [
    ("limit", 0), ("limit", 101), ("limit", True), ("limit", 1.0),
    ("limit", "20"), ("limit", None), ("offset", -1),
    ("offset", 9007199254740992), ("offset", False), ("offset", 0.0),
    ("offset", "0"), ("offset", None),
])
def test_pagination_argument_bounds(tool, ids, key, value):
    def handler(request):
        pytest.fail("Invalid pagination must not reach transport")
    with pytest.raises(ValueError, match="pagination"):
        asyncio.run(client(handler).call_tool(tool, {**ids, key: value}, context_token="ctx"))


@pytest.mark.parametrize("limit,offset,total", [
    (1, 0, 0), (100, 0, 100), (20, 25, 3),
    (1, 9007199254740991, 9007199254740991),
    (1, 9007199254740990, 9007199254740991),
])
def test_valid_pagination_boundaries(limit, offset, total):
    data = page(limit, offset)
    data["pagination"]["totalCount"] = total
    data["items"] = [{} for _ in range(min(limit, max(0, total - offset)))]
    envelope = {"tool": "get_products", "data": data}
    assert asyncio.run(client(lambda r: httpx.Response(200, json=envelope)).get_products(limit, offset, context_token="ctx")) == envelope


@pytest.mark.parametrize("field,value", [
    ("hasMore", False), ("hasMore", 1), ("nextOffset", None),
    ("nextOffset", True), ("nextOffset", 2.0), ("nextOffset", 0),
    ("nextOffset", -1), ("nextOffset", 9007199254740992),
    ("totalCount", -1), ("totalCount", True),
    ("totalCount", 3.0), ("totalCount", 9007199254740992),
])
def test_inconsistent_nonterminal_page(field, value):
    data = {"items": [{}, {}], "pagination": {
        "limit": 2, "offset": 0, "totalCount": 3, "hasMore": True, "nextOffset": 2,
    }}
    data["pagination"][field] = value
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json={"tool": "get_products", "data": data})).get_products(2, context_token="ctx"))


@pytest.mark.parametrize("items", [None, {}, [{}, {}, {}], [None, {}], [1, {}]])
def test_invalid_items_metadata(items):
    data = {"items": items, "pagination": {
        "limit": 2, "offset": 0, "totalCount": 3, "hasMore": True, "nextOffset": 2,
    }}
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json={"tool": "get_products", "data": data})).get_products(2, context_token="ctx"))


@pytest.mark.parametrize("missing", ["limit", "offset", "totalCount", "hasMore", "nextOffset"])
def test_missing_pagination_metadata(missing):
    data = page()
    del data["pagination"][missing]
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json={"tool": "get_products", "data": data})).get_products(context_token="ctx"))


def test_redirect_is_not_followed():
    seen = []
    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(307, headers={"Location": "https://elsewhere.test"})
    with pytest.raises(BackendClientError):
        asyncio.run(client(handler).get_business_info(context_token="ctx"))
    assert seen == ["https://backend.test/internal/ai/data"]


@pytest.mark.parametrize("identifier", [
    "00000000-0000-0000-0000-000000000000",  # nil
    "ffffffff-ffff-ffff-ffff-ffffffffffff",  # max
    "550e8400-e29b-01d4-a716-446655440000",  # no client version policy
    "550e8400-e29b-91d4-a716-446655440000",
    "550e8400-e29b-41d4-0716-446655440000",  # no client variant policy
    "550E8400-E29B-41D4-A716-446655440000",  # uppercase preserved
    "550e8400-e29b-71d4-a716-446655440000",
])
@pytest.mark.parametrize("tool,ids,key", [
    ("get_product_details", {"productId": PRODUCT_ID}, "productId"),
    ("get_product_variants", {"productId": PRODUCT_ID}, "productId"),
    ("get_variant_details", {"productId": PRODUCT_ID, "variantId": VARIANT_ID}, "productId"),
    ("get_variant_details", {"productId": PRODUCT_ID, "variantId": VARIANT_ID}, "variantId"),
    ("get_conversation_history", {"conversationId": CONVERSATION_ID}, "conversationId"),
])
def test_uuid_syntax_does_not_impose_backend_policy(identifier, tool, ids, key):
    def handler(request):
        arguments = json.loads(request.content)["arguments"]
        assert arguments[key] == identifier
        return httpx.Response(200, json={
            "tool": tool, "data": page() if "limit" in arguments else {},
        })
    asyncio.run(client(handler).call_tool(tool, {**ids, key: identifier}, context_token="ctx"))


@pytest.mark.parametrize("count,offset,total,has_more,next_offset", [
    (1, 0, 10, True, 2),   # deletion: short page despite earlier count
    (0, 0, 10, True, 2),   # deletion: all selected rows disappeared
    (2, 0, 0, False, None),  # insertion: rows arrived after count
    (2, 4, 1, False, None),  # deletion: total below offset plus returned rows
    (1, 0, 10, False, None),  # hasMore observed after deletions
    (2, 0, 1, True, 2),    # hasMore observed after insertions
    (1, 4, 10, True, 5),   # Backend advances by actual row count
    (0, 4, 0, False, None),  # empty terminal page beyond total
])
@pytest.mark.parametrize("tool,ids", [
    ("get_products", {}), ("get_product_variants", {"productId": PRODUCT_ID}),
    ("get_conversation_history", {"conversationId": CONVERSATION_ID}),
])
def test_pages_tolerate_separate_database_snapshots(count, offset, total, has_more, next_offset, tool, ids):
    envelope = {"tool": tool, "data": {
        "items": [{"id": index} for index in range(count)],
        "pagination": {"limit": 2, "offset": offset, "totalCount": total,
                       "hasMore": has_more, "nextOffset": next_offset},
    }}
    result = asyncio.run(client(lambda r: httpx.Response(200, json=envelope)).call_tool(
        tool, {**ids, "limit": 2, "offset": offset}, context_token="ctx",
    ))
    assert result == envelope


@pytest.mark.parametrize("next_offset", [0, 3, 4, True, 5.0, 9007199254740992])
def test_next_offset_must_make_safe_progress_from_nonzero_offset(next_offset):
    data = {"items": [], "pagination": {
        "limit": 2, "offset": 4, "totalCount": 10,
        "hasMore": True, "nextOffset": next_offset,
    }}
    with pytest.raises(BackendResponseError):
        asyncio.run(client(lambda r: httpx.Response(200, json={"tool": "get_products", "data": data})).get_products(2, 4, context_token="ctx"))
