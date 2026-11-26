"""CLI-only owner-authenticated GET adapter for verified Backend main.

No S2S impersonation, public ingress, arbitrary routes, production hosts or
conversation-authentication bypass. Full validated tool envelopes are reused.
"""
import hmac
import asyncio
import secrets
from uuid import UUID

import httpx

from .backend_client import (BackendClient, BackendClientError, BackendAuthenticationError,
                             BackendTimeoutError, BackendResponseError, _TOOLS)


MAIN_REVISION = "83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b"
PR_HISTORY_REVISION = "0e92d6b5d038aa6da87c76ee5f06d29aebe4127a"


class DevelopmentBackendClient:
    source = "development-http"

    def __init__(self, base_url, owner_token, business_id, *, revision, transport=None):
        try:
            url = httpx.URL(base_url)
        except (TypeError,httpx.InvalidURL):
            raise ValueError("Invalid development Backend origin") from None
        if (url.scheme not in {"http", "https"} or url.host not in {"127.0.0.1", "localhost", "::1"}
                or url.userinfo or url.query or url.fragment or url.path not in {"", "/"}):
            raise ValueError("Development Backend must be an explicit loopback HTTP(S) origin")
        if revision != MAIN_REVISION:
            raise ValueError("Backend revision is not the reviewed authenticated catalog contract")
        if not isinstance(owner_token, str) or not owner_token.strip() or any(not 32 <= ord(c) < 127 for c in owner_token):
            raise ValueError("Private development owner token is required")
        self.business_id = UUID(str(business_id))
        self._origin, self._owner_token = str(url).rstrip("/"), owner_token
        self._context_token = secrets.token_urlsafe(32)
        self._transport = transport
        self._authenticated = False
        self._auth_lock = asyncio.Lock()

    async def _require_authenticated_main(self, client):
        async with self._auth_lock:
            if self._authenticated:
                return
            response = await client.get(self._origin + "/auth/me",headers={"Authorization":"Bearer " + self._owner_token})
            if response.status_code != 200:
                raise BackendAuthenticationError("Authenticated development Backend capability unavailable")
            identity = response.json()
            if not isinstance(identity,dict) or not isinstance(identity.get("businesses"),list):
                raise BackendResponseError("Invalid development identity response")
            if not any(m.get("id") == str(self.business_id) and m.get("role") == "OWNER"
                       for m in identity.get("businesses",[]) if isinstance(m,dict)):
                raise BackendAuthenticationError("Development business ownership not verified")
            self._authenticated = True

    def local_context_token(self):
        return self._context_token

    async def call_tool(self, tool, arguments=None, *, context_token):
        # Reuse the six-tool contract's strict camelCase UUID/pagination checks.
        arguments = dict(arguments or {})
        if tool not in _TOOLS:
            raise ValueError("Unsupported Backend operation")
        # Use the standalone client's validation without making its HTTP request.
        args = BackendClient.validate_arguments(tool, arguments)
        if not isinstance(context_token, str) or not hmac.compare_digest(context_token, self._context_token):
            raise BackendAuthenticationError("Development request context rejected")
        if tool == "get_conversation_history":
            # Main lacks these endpoints; PR #1 explicitly has no authentication.
            raise BackendClientError("Authenticated development history contract unavailable")
        root = f"/businesses/{self.business_id}"
        params = None
        if tool == "get_business_info":
            path = root
        else:
            path = root + "/products"
            if tool != "get_products":
                path += "/" + args["productId"]
            if tool in {"get_product_variants", "get_variant_details"}:
                path += "/variants"
            if tool == "get_variant_details":
                path += "/" + args["variantId"]
            if tool in {"get_products", "get_product_variants"}:
                params = {"limit": args["limit"], "offset": args["offset"]}
        try:
            async with httpx.AsyncClient(transport=self._transport, trust_env=False, follow_redirects=False, timeout=5.0) as client:
                await self._require_authenticated_main(client)
                response = await client.get(self._origin + path, params=params,
                                            headers={"Authorization": "Bearer " + self._owner_token})
            if response.status_code in {401, 403}:
                self._authenticated = False
                raise BackendAuthenticationError("Development Backend authorization rejected")
            if response.status_code != 200:
                raise BackendClientError("Development Backend read unavailable")
            raw = response.json()
            if tool == "get_business_info":
                raw = {"business": raw}
            envelope = {"tool": tool, "data": raw}
            # Identical envelope/pagination checks to proposed internal tools.
            return BackendClient.validate_envelope(tool, envelope, args)
        except httpx.TimeoutException:
            raise BackendTimeoutError("Development Backend read timed out") from None
        except httpx.HTTPError:
            raise BackendClientError("Development Backend read unavailable") from None
        except (ValueError, TypeError, KeyError):
            raise BackendResponseError("Invalid development Backend response") from None

    async def get_products(self, limit=20, offset=0, *, context_token):
        return await self.call_tool("get_products", {"limit":limit,"offset":offset}, context_token=context_token)

    async def get_product_details(self, product_id, *, context_token):
        return await self.call_tool("get_product_details", {"productId":str(product_id)}, context_token=context_token)

    async def get_product_variants(self, product_id, limit=20, offset=0, *, context_token):
        return await self.call_tool("get_product_variants", {"productId":str(product_id),"limit":limit,"offset":offset}, context_token=context_token)

    async def get_variant_details(self, product_id, variant_id, *, context_token):
        return await self.call_tool("get_variant_details", {"productId":str(product_id),"variantId":str(variant_id)}, context_token=context_token)

    async def get_conversation_history(self, conversation_id, limit=20, offset=0, *, context_token):
        return await self.call_tool("get_conversation_history", {"conversationId":str(conversation_id),"limit":limit,"offset":offset}, context_token=context_token)

    async def get_business_info(self, *, context_token):
        return await self.call_tool("get_business_info", {}, context_token=context_token)


def validate_pending_history_contract(conversation, page, scope):
    """Offline mapping for PR #1, not permission to use its unauthenticated routes."""
    from ..schemas.backend import Page, HistoryMessage
    try:
        if (UUID(conversation["id"]) != scope.conversation_id or UUID(conversation["businessId"]) != scope.business_id
                or UUID(conversation["customerId"]) != scope.customer_id):
            raise ValueError()
        if any(UUID(row["conversationId"]) != scope.conversation_id for row in page["items"]):
            raise ValueError()
        return {"tool":"get_conversation_history", "data":Page[HistoryMessage].model_validate(page).model_dump(mode="json")}
    except (ValueError,TypeError,KeyError,AttributeError):
        raise ValueError("Invalid or unscoped pending history response") from None
