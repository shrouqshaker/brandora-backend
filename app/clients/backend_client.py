"""Standalone client for the proposed read-only Backend AI data contract.

Context tokens are supplied per call, never stored on the reusable client.
Identifiers use canonical UUID syntax without version/variant restrictions;
the Backend owns identifier policy. Pagination defaults to 20/0.
call_tool accepts Backend camelCase keys; convenience methods use snake_case.
"""

import json
import math
from typing import Any, Mapping
from uuid import UUID

import httpx


class BackendClientError(Exception):
    """A sanitized Backend transport or contract error."""


class BackendAuthenticationError(BackendClientError):
    """The Backend rejected service or customer context authentication."""


class BackendTimeoutError(BackendClientError):
    """The Backend request exceeded its timeout."""


class BackendResponseError(BackendClientError):
    """The Backend returned an invalid response envelope or exceeded its byte cap."""


_TOOLS = {
    "get_products": (set(), {"limit", "offset"}),
    "get_product_details": ({"productId"}, set()),
    "get_product_variants": ({"productId"}, {"limit", "offset"}),
    "get_variant_details": ({"productId", "variantId"}, set()),
    "get_conversation_history": ({"conversationId"}, {"limit", "offset"}),
    "get_business_info": (set(), set()),
}

_MAX_SAFE_INTEGER = 2**53 - 1
PRODUCT_TOOLS = frozenset({"get_products", "get_product_details", "get_product_variants", "get_variant_details"})
CONVERSATION_TOOLS = PRODUCT_TOOLS | {"get_conversation_history"}


def _uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return str(parsed) == value.lower()


def _token(value: str) -> bool:
    return isinstance(value, str) and bool(value.strip()) and all(
        32 <= ord(char) < 127 for char in value
    )


class BackendClient:
    """Call only the six approved read-only tools; never retry requests.

    ``transport`` supports offline tests with httpx.MockTransport. Redirects and
    environment proxy configuration are disabled to avoid forwarding tokens.
    Each call owns its HTTP client and headers, including concurrent calls. A
    bounded streaming reader rejects oversized responses before JSON parsing.
    """

    def __init__(
        self,
        base_url: str,
        service_token: str,
        *,
        timeout: float = 10.0,
        max_response_bytes: int = 1_048_576,
        transport: httpx.AsyncBaseTransport | None = None,
        allowed_tools: frozenset[str] | None = None,
    ) -> None:
        try:
            url = httpx.URL(base_url)
        except (TypeError, httpx.InvalidURL):
            raise ValueError("Invalid Backend base URL") from None
        if (url.scheme not in {"http", "https"} or not url.host
                or url.userinfo or url.query or url.fragment
                or url.path not in {"", "/"}):
            raise ValueError("Backend base URL must be an HTTP(S) origin")
        if url.scheme == "http" and url.host not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Nonlocal Backend origins require HTTPS")
        self._allowed_tools = frozenset(_TOOLS) if allowed_tools is None else frozenset(allowed_tools)
        if not self._allowed_tools or not self._allowed_tools <= _TOOLS.keys():
            raise ValueError("Invalid Backend tool allowlist")
        if not _token(service_token):
            raise ValueError("Invalid Backend service token")
        if (type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 64 * 1024 * 1024):
            raise ValueError("Backend response byte cap must be an integer between 1 and 67108864")
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("Backend timeout must be a positive finite number")
        self._endpoint = str(url.copy_with(path="/internal/ai/data"))
        self._service_token = service_token
        self._timeout = timeout
        self._max_response_bytes = max_response_bytes
        self._transport = transport

    @staticmethod
    def validate_arguments(tool: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(tool, str) or tool not in _TOOLS:
            raise ValueError("Unsupported Backend tool")
        if not isinstance(arguments, Mapping):
            raise ValueError("Backend arguments must be a mapping")
        required, optional = _TOOLS[tool]
        args = dict(arguments)
        if not required <= args.keys() or args.keys() - required - optional:
            raise ValueError("Invalid Backend tool arguments")
        for key in required:
            if not _uuid(args[key]):
                raise ValueError("Backend identifiers must be canonical UUID strings")
        if optional:
            args.setdefault("limit", 20)
            args.setdefault("offset", 0)
            if (type(args["limit"]) is not int or not 1 <= args["limit"] <= 100
                    or type(args["offset"]) is not int
                    or not 0 <= args["offset"] <= _MAX_SAFE_INTEGER):
                raise ValueError("Invalid Backend pagination arguments")
        return args

    async def _read_json_response(self, response: httpx.Response) -> Any:
        """Read at most the configured cap, validating declared length and UTF-8."""
        declared_raw = response.headers.get("Content-Length")
        declared: int | None = None
        if declared_raw is not None:
            try:
                declared = int(declared_raw)
            except (TypeError, ValueError):
                raise BackendResponseError("Backend returned invalid response length") from None
            if declared < 0 or declared > self._max_response_bytes:
                raise BackendResponseError("Backend response exceeded byte limit") from None

        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > self._max_response_bytes:
                raise BackendResponseError("Backend response exceeded byte limit") from None
            chunks.append(chunk)
        if declared is not None and declared != total:
            raise BackendResponseError("Backend returned invalid response length") from None
        try:
            return json.loads(b"".join(chunks).decode("utf-8"))
        except (ValueError, UnicodeError):
            raise BackendResponseError("Backend returned invalid JSON") from None

    async def call_tool(
        self, tool: str, arguments: Mapping[str, Any], *, context_token: str
    ) -> dict[str, Any]:
        if tool not in self._allowed_tools:
            raise ValueError("Unsupported Backend tool")
        args = self.validate_arguments(tool, arguments)
        if not _token(context_token):
            raise ValueError("Invalid Backend context token")
        headers = {
            "Authorization": f"Bearer {self._service_token}",
            "X-AI-Context": context_token,
        }
        # Do not propagate upstream text, URLs, headers, or exception chains.
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport,
                follow_redirects=False, trust_env=False,
            ) as client:
                async with client.stream(
                    "POST", self._endpoint, headers=headers,
                    json={"tool": tool, "arguments": args},
                ) as response:
                    if response.status_code in {401, 403}:
                        raise BackendAuthenticationError("Backend authentication failed")
                    if not 200 <= response.status_code < 300:
                        raise BackendClientError(
                            f"Backend returned HTTP {response.status_code}"
                        ) from None
                    envelope = await self._read_json_response(response)
        except (BackendAuthenticationError, BackendResponseError, BackendClientError):
            raise
        except httpx.TimeoutException:
            raise BackendTimeoutError("Backend request timed out") from None
        except httpx.HTTPError:
            raise BackendClientError("Backend request failed") from None
        return self.validate_envelope(tool, envelope, args)

    @staticmethod
    def validate_envelope(tool, envelope, args):
        if (not isinstance(envelope, dict) or envelope.get("tool") != tool
                or not isinstance(envelope.get("data"), dict)):
            raise BackendResponseError("Invalid Backend response envelope")
        data = envelope["data"]
        if _TOOLS[tool][1]:
            BackendClient._validate_page(data, args)
        return envelope

    @staticmethod
    def _validate_page(data: dict[str, Any], args: dict[str, Any]) -> None:
        page = data.get("pagination")
        valid = isinstance(data.get("items"), list) and isinstance(page, dict)
        if valid:
            valid = (
                type(page.get("limit")) is int and page["limit"] == args["limit"]
                and type(page.get("offset")) is int and page["offset"] == args["offset"]
                and type(page.get("totalCount")) is int
                and 0 <= page["totalCount"] <= _MAX_SAFE_INTEGER
                and type(page.get("hasMore")) is bool
                and "nextOffset" in page
                and len(data["items"]) <= args["limit"]
                and all(isinstance(item, dict) for item in data["items"])
            )
        if valid:
            # Counts and rows need not share a database snapshot. Do not infer
            # hasMore or page fullness from totalCount or the returned rows.
            # Treat nextOffset as Backend-owned, requiring only safe progress.
            next_offset = page["nextOffset"]
            valid = (type(next_offset) is int
                     and args["offset"] < next_offset <= _MAX_SAFE_INTEGER
                     if page["hasMore"] else next_offset is None)
        if not valid:
            raise BackendResponseError("Invalid Backend pagination envelope")

    async def get_products(self, limit: int = 20, offset: int = 0, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_products", {"limit": limit, "offset": offset}, context_token=context_token)

    async def get_product_details(self, product_id: str, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_product_details", {"productId": product_id}, context_token=context_token)

    async def get_product_variants(self, product_id: str, limit: int = 20, offset: int = 0, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_product_variants", {"productId": product_id, "limit": limit, "offset": offset}, context_token=context_token)

    async def get_variant_details(self, product_id: str, variant_id: str, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_variant_details", {"productId": product_id, "variantId": variant_id}, context_token=context_token)

    async def get_conversation_history(self, conversation_id: str, limit: int = 20, offset: int = 0, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_conversation_history", {"conversationId": conversation_id, "limit": limit, "offset": offset}, context_token=context_token)

    async def get_business_info(self, *, context_token: str) -> dict[str, Any]:
        return await self.call_tool("get_business_info", {}, context_token=context_token)
