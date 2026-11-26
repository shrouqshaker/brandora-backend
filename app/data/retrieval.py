"""Deterministic, bounded evidence retrieval; no replies, orders or live wiring."""
import asyncio
from dataclasses import dataclass, field
from enum import Enum
import math
import time
from typing import Callable
from uuid import UUID

from ..nlu import extract_entities, find_products, normalize, product_token_keys, tok_match
from ..schemas import Intent
from ..schemas.backend import (
    ExpectedScope, Page, Product, ProductVariant,
    RetrievalOutcome, RetrievalStatus,
)
from ..schemas.request import CatalogItem
from ..schemas.inquiry import Inquiry as RetrievalQuery, VariantReference  # compatibility imports
from .backend import BackendDataAccess
from .history import PreparedHistory, is_contextual_followup
from .options import resolve_options, variant_matches_options
from .search import canonical_search, search_terms
from .routing import route_current_inquiry


@dataclass(frozen=True)
class RetrievalLimits:
    max_calls: int = 8
    max_product_pages: int = 3
    max_records: int = 100
    max_detail_lookups: int = 4
    max_elapsed_seconds: float = 5.0
    page_size: int = 10

    def __post_init__(self):
        for value in (self.max_calls, self.max_product_pages, self.max_records,
                      self.max_detail_lookups, self.page_size):
            if type(value) is not int or value <= 0:
                raise ValueError("Retrieval limits must be positive integers")
        if self.page_size > 100:
            raise ValueError("Retrieval page size exceeds Backend limit")
        if (isinstance(self.max_elapsed_seconds, bool)
                or not isinstance(self.max_elapsed_seconds, (int, float))
                or not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0):
            raise ValueError("Retrieval deadline must be positive and finite")


class RetrievalDecision(str, Enum):
    SKIP = "skip"
    PRODUCTS = "products"
    BUSINESS = "business"
    CLARIFY = "clarify"
    UNSUPPORTED = "unsupported"


class SearchCoverage(str, Enum):
    NOT_SEARCHED = "not_searched"
    PARTIAL = "partial"
    EXHAUSTED = "exhausted"  # terminal traversal, never a stable database snapshot
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class VariantCoverage:
    product_id: UUID = field(repr=False)
    coverage: SearchCoverage


@dataclass(frozen=True)
class RetrievalResult:
    decision: RetrievalDecision
    status: RetrievalStatus | None = None
    failure: RetrievalStatus | None = None
    candidates: tuple[Product, ...] = field(default=(), repr=False)
    variants: tuple[ProductVariant, ...] = field(default=(), repr=False)
    evidence: tuple[RetrievalOutcome, ...] = field(default=(), repr=False)
    catalog_coverage: SearchCoverage = SearchCoverage.NOT_SEARCHED
    variant_coverage: tuple[VariantCoverage, ...] = field(default=(), repr=False)
    needs_clarification: bool = False
    issues: tuple[str, ...] = ()
    backend_calls: int = 0
    product_pages: int = 0
    records_inspected: int = 0
    detail_lookups: int = 0
    cache_hits: int = 0
    inquiry: RetrievalQuery | None = field(default=None, repr=False)


class _Stop(Exception):
    pass


def _matches(text: str, products: list[Product]) -> list[Product]:
    # Reuse tested legacy token scoring. This projection is matching-only:
    # no price budget and no parent inventory are used to rank Backend evidence.
    projections = [CatalogItem(id=p.id, name=p.name, attributes=p.attributes,
                               isActive=p.isActive, basePrice=None, trackInventory=False)
                   for p in products]
    terms = extract_entities(canonical_search(text)).product_tokens
    eligible = []
    for product in projections:
        keys = product_token_keys(product)
        keys |= set(search_terms(" ".join(keys)))
        # Preserve typo/synonym normalization, but never discard a substantive
        # qualifier simply because half of a long question matched one noun.
        if terms and all(any(tok_match(t.key,key) for key in keys) for t in terms):
            eligible.append(product)
    selected = {str(p.id) for p in find_products(terms, eligible)}
    return [p for p in products if str(p.id) in selected]


def _record_cost(data) -> int:
    if isinstance(data, Page):
        return sum(_record_cost(item) for item in data.items)
    return 1 + len(data.variants) if isinstance(data, Product) else 1


class _Execution:
    """Created per retrieve call; contains all scope, tokens, cache and evidence."""
    def __init__(self, data, limits, clock, scope, token, inquiry):
        self.data, self.limits, self.clock = data, limits, clock
        self.scope, self.token = scope, token
        self.inquiry = inquiry
        self.deadline = clock() + limits.max_elapsed_seconds
        self.calls = self.pages = self.records = self.details = self.cache_hits = 0
        self.cache = {}
        self.evidence = []
        self.products = {}
        self.variants = {}
        self.variant_coverage = {}
        self.catalog_coverage = SearchCoverage.NOT_SEARCHED
        self.issues = []
        self.failure = None
        self.clarify = False

    def stop(self, issue):
        self.issues.append(issue)
        raise _Stop

    def fail_scope(self, status=RetrievalStatus.SCOPE_MISMATCH):
        self.failure = status
        self.products.clear()
        self.variants.clear()
        self.evidence.clear()
        self.cache.clear()
        self.variant_coverage.clear()
        self.catalog_coverage = SearchCoverage.UNAVAILABLE
        self.stop(status.value)

    async def fetch(self, method, *args):
        if method not in {"get_products", "get_product_details", "get_product_variants",
                          "get_variant_details", "get_business_info"}:
            raise ValueError("Unsupported retrieval operation")
        key = (method, args)
        if key in self.cache:
            self.cache_hits += 1
            return self.cache[key]
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            self.stop("elapsed_limit")
        if self.calls >= self.limits.max_calls:
            self.stop("call_limit")
        if self.records >= self.limits.max_records:
            self.stop("record_limit")
        detail = method in {"get_product_details", "get_variant_details"}
        if detail and self.details >= self.limits.max_detail_lookups:
            self.stop("detail_limit")
        if method == "get_products":
            if self.pages >= self.limits.max_product_pages:
                self.stop("product_page_limit")
            self.pages += 1
        self.calls += 1
        self.details += int(detail)
        try:
            outcome = await asyncio.wait_for(getattr(self.data, method)(
                *args, scope=self.scope, context_token=self.token), timeout=remaining)
        except asyncio.TimeoutError:
            self.failure = RetrievalStatus.UNAVAILABLE
            self.stop("timeout")
        # Injected fakes may reuse nested models. Execution always owns its copy.
        outcome = outcome.model_copy(deep=True)
        if outcome.status in {RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH}:
            self.fail_scope(outcome.status)
        if outcome.envelope is None:
            self.failure = outcome.status
            self.stop(outcome.error or "backend_error")
        cost = _record_cost(outcome.envelope.data)
        if cost > self.limits.max_records - self.records:
            self.stop("record_limit")
        self.records += cost
        self.cache[key] = outcome.envelope.data
        self.evidence.append(outcome)
        return outcome.envelope.data

    def result(self, decision):
        if self.calls and self.clock() >= self.deadline:
            self.issues.append("elapsed_limit")
        if self.catalog_coverage == SearchCoverage.PARTIAL and self.failure and not self.evidence:
            self.catalog_coverage = SearchCoverage.UNAVAILABLE
        if self.failure in {RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH}:
            status = self.failure
        elif self.failure or self.issues:
            status = RetrievalStatus.PARTIAL if self.evidence else self.failure or RetrievalStatus.PARTIAL
        elif self.catalog_coverage == SearchCoverage.PARTIAL or SearchCoverage.PARTIAL in self.variant_coverage.values():
            status = RetrievalStatus.PARTIAL
        elif self.evidence:
            status = RetrievalStatus.AVAILABLE if self.products or self.variants or decision == RetrievalDecision.BUSINESS else RetrievalStatus.EMPTY
        else:
            status = None
        return RetrievalResult(
            decision=decision, status=status, failure=self.failure,
            candidates=tuple(self.products.values()), variants=tuple(self.variants.values()),
            evidence=tuple(self.evidence), catalog_coverage=self.catalog_coverage,
            variant_coverage=tuple(VariantCoverage(key, value) for key, value in self.variant_coverage.items()),
            needs_clarification=self.clarify or len(self.products) > 1,
            issues=tuple(dict.fromkeys(self.issues)), backend_calls=self.calls, product_pages=self.pages,
            records_inspected=self.records, detail_lookups=self.details, cache_hits=self.cache_hits,
            inquiry=self.inquiry,
        )


_ORDER_ACTIONS = {Intent.ORDER_STATUS, Intent.ORDER_MODIFY, Intent.ORDER_CANCEL,
                  Intent.PAYMENT_DISPUTE, Intent.LEGAL_THREAT, Intent.CUSTOM_REQUEST, Intent.COMPLAINT}
_BUSINESS_NAME = ("business name", "store name", "shop name", "اسم المحل", "اسم النشاط", "اسم المتجر")
_VARIANT_WORDS = ("stock", "available", "availability", "options", "colors", "colours", "sizes",
                  "متوفر", "موجود", "عندكم", "الوان", "مقاسات", "مخزون")
_BROWSE_WORDS = {"show", "products", "product", "items", "catalog", "catalogue", "منتجات", "المنتجات", "عرض", "الكتالوج", "كتالوج"}


def _browse(text):
    tokens = extract_entities(text).product_tokens
    return not tokens or all(normalize(token.orig) in _BROWSE_WORDS for token in tokens)


class RetrievalCoordinator:
    def __init__(self, data: BackendDataAccess, limits: RetrievalLimits | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self._data = data
        self._limits = limits or RetrievalLimits()
        self._clock = clock

    async def retrieve(self, query: RetrievalQuery, *, scope: ExpectedScope, context_token: str,
                       history: PreparedHistory | None = None,
                       history_scope: ExpectedScope | None = None) -> RetrievalResult:
        execution = _Execution(self._data, self._limits, self._clock, scope, context_token, query)
        route = route_current_inquiry(query.text)
        intent = route.intents[0] if route.intents else Intent.UNKNOWN
        entities = extract_entities(query.text)
        text = normalize(query.text)
        selectors = list(query.product_ids) + [ref.product_id for ref in query.variant_references]
        followup = is_contextual_followup(query.text)
        if intent in {Intent.GREETING, Intent.THANKYOU} and len(route.intents) == 1 and not selectors and not query.option_values:
            return execution.result(RetrievalDecision.SKIP)
        if intent in _ORDER_ACTIONS or intent == Intent.RETURNS_POLICY:
            return execution.result(RetrievalDecision.UNSUPPORTED)
        decision = RetrievalDecision.PRODUCTS
        try:
            if history is not None and history.failure in {RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH}:
                execution.fail_scope(history.failure)
            if followup:
                execution.clarify = True
                if history is None:
                    return execution.result(RetrievalDecision.CLARIFY)
                if (history_scope != scope or scope.customer_id is None or scope.conversation_id is None):
                    execution.fail_scope()
                execution.issues.append("provisional_history_references")
                selectors.extend(h.product_id for h in history.references[:self._limits.max_records] if h.product_id)
            elif intent == Intent.UNKNOWN and not selectors and not any(term in text for term in _BUSINESS_NAME):
                # Short answers without supplied history never become confirmations.
                return execution.result(RetrievalDecision.CLARIFY)
            if any(term in text for term in _BUSINESS_NAME) and not selectors:
                decision = RetrievalDecision.BUSINESS
                await execution.fetch("get_business_info")
                return execution.result(decision)
            if intent == Intent.GENERAL_INFO and not selectors:
                # Current aggregate models identity/name only; no policy APIs exist.
                return execution.result(RetrievalDecision.UNSUPPORTED)
            if followup and not selectors:
                return execution.result(RetrievalDecision.CLARIFY)
            if not selectors:
                if intent not in {Intent.PRODUCT_INQUIRY, Intent.PRICE_INQUIRY, Intent.CREATE_ORDER}:
                    return execution.result(RetrievalDecision.CLARIFY)
                await self._discover(execution, query.text)
                # Only one locally plausible candidate is worth a detail lookup.
                # It remains provisional when the catalog search was truncated.
                if len(execution.products) == 1 and not _browse(query.text):
                    selectors.extend(execution.products)
            for identifier in selectors:
                product = await execution.fetch("get_product_details", identifier)
                if product.isActive:
                    execution.products[product.id] = product
                else:
                    execution.products.pop(product.id, None)
                    execution.issues.append("inactive_product")
            execution.clarify |= intent == Intent.CREATE_ORDER
            needs_variants = bool(query.variant_references or intent == Intent.PRICE_INQUIRY
                                  or entities.color or entities.size
                                  or any(term in text for term in _VARIANT_WORDS))
            if len(execution.products) == 1:
                selection = resolve_options(next(iter(execution.products.values())), query.text, query.option_values, query.option_alternatives)
                needs_variants |= bool(selection.values or selection.alternatives or selection.unresolved)
                if followup and history is not None:
                    parent_id = next(iter(execution.products))
                    needs_variants |= any(h.product_id == parent_id and h.variant_id is not None
                                          for h in history.references[:self._limits.max_records])
            if len(execution.products) == 1 and needs_variants:
                product = next(iter(execution.products.values()))
                explicit = [ref.variant_id for ref in query.variant_references if ref.product_id == product.id]
                if followup:
                    explicit.extend(h.variant_id for h in history.references[:self._limits.max_records]
                                    if h.product_id == product.id and h.variant_id)
                await self._variants(execution, product, explicit, resolve_options(product, query.text, query.option_values, query.option_alternatives))
            elif len(execution.products) > 1:
                execution.clarify = True
        except _Stop:
            pass
        return execution.result(decision)

    async def _discover(self, execution, text):
        offset = 0
        execution.catalog_coverage = SearchCoverage.PARTIAL
        while True:
            limit = min(self._limits.page_size, self._limits.max_records - execution.records)
            page = await execution.fetch("get_products", limit, offset)
            active = [product for product in page.items if product.isActive]
            matches = _matches(text, active)
            generic = _browse(text)
            for product in active if generic else matches:
                execution.products.setdefault(product.id, product)
            if not page.pagination.hasMore:
                execution.catalog_coverage = SearchCoverage.EXHAUSTED
                return
            if execution.products:
                # Stop once useful candidates exist; do not download a catalog
                # just to claim global uniqueness or absence of alternatives.
                return
            offset = page.pagination.nextOffset

    async def _variants(self, execution, product, explicit, selection):
        execution.variant_coverage[product.id] = SearchCoverage.PARTIAL
        if explicit:
            for identifier in explicit:
                variant = await execution.fetch("get_variant_details", product.id, identifier)
                if variant.isActive and variant_matches_options(product, variant, selection):
                    execution.variants[variant.id] = variant
                else:
                    execution.issues.append("inactive_variant" if not variant.isActive else "variant_options_mismatch")
                    execution.clarify = True
            return  # specific detail lookups never prove list completeness
        variants = {variant.id: variant for variant in product.variants}
        metadata = product.variantsPagination
        if metadata.offset == 0 and not metadata.hasMore:
            execution.variant_coverage[product.id] = SearchCoverage.EXHAUSTED
        else:
            offset = metadata.nextOffset if metadata.offset == 0 else 0
            while True:
                limit = min(self._limits.page_size, self._limits.max_records - execution.records)
                page = await execution.fetch("get_product_variants", product.id, limit, offset)
                variants.update((variant.id, variant) for variant in page.items)
                if not page.pagination.hasMore:
                    execution.variant_coverage[product.id] = SearchCoverage.EXHAUSTED
                    break
                offset = page.pagination.nextOffset
        active = [variant for variant in variants.values() if variant.isActive]
        selected = [variant for variant in active if variant_matches_options(product, variant, selection)]
        execution.variants.update((variant.id, variant) for variant in selected)
        if selection.values and len(selected) == 1:
            variant = await execution.fetch("get_variant_details", product.id, selected[0].id)
            execution.variants.pop(variant.id, None)
            if variant.isActive and variant_matches_options(product, variant, selection):
                execution.variants[variant.id] = variant
            else:
                execution.issues.append("inactive_variant" if not variant.isActive else "variant_options_mismatch")
                execution.clarify = True
        elif (selection.values or selection.unresolved) and not selected:
            execution.issues.append("no_verified_matching_variant")
