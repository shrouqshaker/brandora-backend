"""One-call typed Backend access. No cache, retries, token storage, or orchestration."""
from copy import deepcopy
from typing import Callable, TypeVar
from uuid import UUID

from pydantic import ValidationError

from ..clients.backend_client import (
    BackendAuthenticationError, BackendClient, BackendClientError,
    BackendResponseError, BackendTimeoutError,
)
from ..schemas.backend import (
    BusinessInformation, ExpectedScope, HistoryMessage, Page, Product, AuthorizedHistoryPage,
    ProductVariant, RetrievalOutcome, RetrievalStatus, ToolEnvelope,
)

T = TypeVar("T")


class _ScopeMismatch(Exception):
    pass


def _same(actual: UUID, expected: UUID) -> None:
    if actual != expected:
        raise _ScopeMismatch


def _variant(variant: ProductVariant, scope: ExpectedScope, product_id: UUID) -> None:
    _same(variant.businessId, scope.business_id)
    _same(variant.catalogItemId, product_id)


def _product(product: Product, scope: ExpectedScope) -> None:
    _same(product.businessId, scope.business_id)
    for variant in product.variants:
        _variant(variant, scope, product.id)


def _status(data) -> RetrievalStatus:
    if isinstance(data, Page):
        if data.pagination.hasMore or any(
            isinstance(item, Product) and item.variantsPagination.hasMore for item in data.items
        ):
            return RetrievalStatus.PARTIAL
        return RetrievalStatus.AVAILABLE if data.items else RetrievalStatus.EMPTY
    if isinstance(data, Product) and data.variantsPagination.hasMore:
        return RetrievalStatus.PARTIAL
    return RetrievalStatus.AVAILABLE


class BackendDataAccess:
    """Inject a BackendClient (or compatible fake); scope and token stay per call.

    Scope is supplied by trusted application code, never derived from model text.
    This class does not authenticate it. Backend must still enforce authorization.
    Returned envelopes retain tool/data while normalizing into validated models.
    """
    def __init__(self, client: BackendClient):
        self._client = client

    async def _read(self, method: str, args: tuple, *, context_token: str,
                    data_type: type[T], check: Callable[[T], None]) -> RetrievalOutcome[T]:
        try:
            raw = await getattr(self._client, method)(*args, context_token=context_token)
        except BackendAuthenticationError:
            return RetrievalOutcome(status=RetrievalStatus.AUTHORIZATION_FAILED, error="authorization_failed")
        except BackendTimeoutError:
            return RetrievalOutcome(status=RetrievalStatus.UNAVAILABLE, error="timeout")
        except BackendResponseError:
            return RetrievalOutcome(status=RetrievalStatus.INVALID, error="invalid_response")
        except BackendClientError:
            return RetrievalOutcome(status=RetrievalStatus.UNAVAILABLE, error="backend_error")
        except ValueError:
            return RetrievalOutcome(status=RetrievalStatus.INVALID, error="invalid_arguments")
        try:
            # Own all nested dictionaries/lists even when an injected client
            # reuses its response object between concurrent calls.
            envelope = ToolEnvelope[data_type].model_validate(deepcopy(raw))
            if envelope.tool != method:
                raise ValueError("Unexpected tool")
            check(envelope.data)
        except _ScopeMismatch:
            return RetrievalOutcome(status=RetrievalStatus.SCOPE_MISMATCH, error="scope_mismatch")
        except (ValidationError, ValueError, TypeError):
            # Do not retain validation errors: they include raw Backend input.
            return RetrievalOutcome(status=RetrievalStatus.INVALID, error="invalid_response")
        return RetrievalOutcome(status=_status(envelope.data), envelope=envelope)

    async def get_products(self, limit: int = 20, offset: int = 0, *,
                           scope: ExpectedScope, context_token: str) -> RetrievalOutcome[Page[Product]]:
        def check(page):
            for product in page.items:
                _product(product, scope)
        return await self._read("get_products", (limit, offset), context_token=context_token,
                                data_type=Page[Product], check=check)

    async def get_product_details(self, product_id: UUID, *, scope: ExpectedScope,
                                  context_token: str) -> RetrievalOutcome[Product]:
        def check(product):
            _same(product.id, UUID(str(product_id)))
            _product(product, scope)
        return await self._read("get_product_details", (str(product_id),), context_token=context_token,
                                data_type=Product, check=check)

    async def get_product_variants(self, product_id: UUID, limit: int = 20, offset: int = 0, *,
                                   scope: ExpectedScope, context_token: str) -> RetrievalOutcome[Page[ProductVariant]]:
        def check(page):
            for variant in page.items:
                _variant(variant, scope, UUID(str(product_id)))
        return await self._read("get_product_variants", (str(product_id), limit, offset), context_token=context_token,
                                data_type=Page[ProductVariant], check=check)

    async def get_variant_details(self, product_id: UUID, variant_id: UUID, *,
                                  scope: ExpectedScope, context_token: str) -> RetrievalOutcome[ProductVariant]:
        def check(variant):
            _same(variant.id, UUID(str(variant_id)))
            _variant(variant, scope, UUID(str(product_id)))
        return await self._read("get_variant_details", (str(product_id), str(variant_id)), context_token=context_token,
                                data_type=ProductVariant, check=check)

    async def get_conversation_history(self, conversation_id: UUID, limit: int = 20, offset: int = 0, *,
                                      scope: ExpectedScope, context_token: str,
                                      before_message_id: UUID | None = None):
        if scope.customer_id is None or scope.conversation_id is None:
            return RetrievalOutcome(status=RetrievalStatus.SCOPE_MISMATCH, error="scope_mismatch")
        try:
            _same(UUID(str(conversation_id)), scope.conversation_id)
        except (_ScopeMismatch, ValueError):
            return RetrievalOutcome(status=RetrievalStatus.SCOPE_MISMATCH, error="scope_mismatch")
        if before_message_id is not None:
            def check(page):
                _same(page.businessId,scope.business_id)
                _same(page.customerId,scope.customer_id)
                _same(page.conversationId,scope.conversation_id)
                _same(page.beforeMessageId,UUID(str(before_message_id)))
                for row in page.items:
                    _same(row.conversationId,scope.conversation_id)
            return await self._read("get_conversation_history",(str(conversation_id),limit,offset),
                context_token=context_token,data_type=AuthorizedHistoryPage,check=check)
        # Legacy foundation only: PR rows do not prove scope. Canonical callers
        # must provide before_message_id to require the authenticated profile.
        # Only Backend authorization can attest ownership; do not fabricate it.
        return await self._read("get_conversation_history", (str(conversation_id), limit, offset),
                                context_token=context_token, data_type=Page[HistoryMessage], check=lambda page: None)

    async def get_business_info(self, *, scope: ExpectedScope,
                                context_token: str) -> RetrievalOutcome[BusinessInformation]:
        return await self._read("get_business_info", (), context_token=context_token,
                                data_type=BusinessInformation, check=lambda info: _same(info.business.id, scope.business_id))
