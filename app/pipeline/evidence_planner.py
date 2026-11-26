"""Standalone read-only planning from scoped Backend evidence. No tool execution.

Draft statements are deterministic material for later generation/guarding, not a
new live response path. Legacy Planner, Guard and v1 behavior remain unchanged.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from uuid import UUID

from pydantic import ValidationError

from ..data.history import PreparedHistory, is_contextual_followup
from ..data.options import resolve_options, variant_matches_options, variant_options_valid
from ..data.retrieval import RetrievalDecision, RetrievalQuery, RetrievalResult, SearchCoverage, VariantCoverage
from ..nlu import detect_language, extract_entities, normalize
from ..data.routing import route_current_inquiry
from ..prompts.templates import t
from ..schemas import E03Intent, Intent, OWNER_REVIEW_INTENTS
from ..schemas.backend import APPLICATION_CURRENCY, BusinessInformation, InventoryState, Page, Product, ProductVariant, RetrievalStatus
from ..schemas.response import AiResponse, ReviewReason
from ..schemas.inquiry import Inquiry as PlanningInquiry  # compatibility name


class Resolution(str, Enum):
    SIMPLE_RESPONSE = "simple_response"
    BUSINESS_INFO = "business_info"
    PRODUCT_AMBIGUITY = "product_ambiguity"
    SINGLE_VARIANT = "single_variant"
    MULTIPLE_VARIANTS = "multiple_variants"
    NO_MATCH_EXHAUSTED = "no_match_exhausted"
    NO_MATCH_PARTIAL = "no_match_partial"
    MISSING_DETAIL = "missing_detail"
    INACTIVE = "inactive"
    CLARIFY = "clarify"
    UNSUPPORTED = "unsupported"
    UNAVAILABLE = "unavailable"
    INVALID = "invalid"
    AUTHORIZATION_FAILED = "authorization_failed"
    SCOPE_MISMATCH = "scope_mismatch"


@dataclass(frozen=True)
class EvidenceSource:
    tool: str
    envelope_index: int | None
    path: str = field(repr=False)


@dataclass(frozen=True)
class ProductFact:
    product_id: UUID = field(repr=False)
    business_id: UUID = field(repr=False)
    name: str = field(repr=False)
    base_price: Decimal | None
    active: bool
    sellable: bool
    declared_options: tuple[tuple[str, tuple[str, ...]], ...] = field(repr=False)
    source: EvidenceSource


@dataclass(frozen=True)
class VariantFact:
    product_id: UUID = field(repr=False)
    variant_id: UUID = field(repr=False)
    option_values: tuple[tuple[str, str], ...] = field(repr=False)
    effective_price: Decimal | None
    currency: str
    inventory: InventoryState
    recorded_quantity: int | None
    active: bool
    parent_active: bool
    options_verified: bool
    source: EvidenceSource
    parent_source: EvidenceSource


@dataclass(frozen=True)
class CandidateReference:
    product_id: UUID = field(repr=False)
    variant_id: UUID | None = field(repr=False)
    origin: str
    revalidated: bool


@dataclass(frozen=True)
class GroundedStatement:
    kind: str
    text: str = field(repr=False)
    sources: tuple[EvidenceSource, ...]
    product_id: UUID | None = field(default=None, repr=False)
    variant_id: UUID | None = field(default=None, repr=False)


@dataclass(frozen=True)
class EvidencePlan:
    intent: E03Intent
    language: str
    resolution: Resolution
    products: tuple[ProductFact, ...] = field(default=(), repr=False)
    variants: tuple[VariantFact, ...] = field(default=(), repr=False)
    references: tuple[CandidateReference, ...] = field(default=(), repr=False)
    matching_variant_ids: tuple[UUID, ...] = field(default=(), repr=False)
    selected_variant_id: UUID | None = field(default=None, repr=False)
    requested_quantity: int | None = None  # customer request, never reserved inventory
    requires_clarification: bool = False
    requires_review: bool = False
    missing_facts: tuple[str, ...] = ()
    ambiguities: tuple[str, ...] = ()
    limitations: tuple[str, ...] = ()
    catalog_coverage: SearchCoverage = SearchCoverage.NOT_SEARCHED
    variant_coverage: tuple[VariantCoverage, ...] = field(default=(), repr=False)
    statements: tuple[GroundedStatement, ...] = field(default=(), repr=False)
    comparison: bool = False
    reply_focus: str = "discovery"
    show_price: bool = True
    reply_script: str = "native"
    comparison_metric: str = "preference"
    comparison_alternatives: tuple[tuple[str, tuple[str, ...]], ...] = field(default=(), repr=False)
    review_reason: ReviewReason | None = None
    allow_stock_quantity_disclosure: bool = False

    @property
    def draft(self) -> str:
        return "\n".join(statement.text for statement in self.statements)

    def to_response(self) -> AiResponse:
        """Schema-compatible deterministic draft; never creates an order candidate."""
        return AiResponse(intent=self.intent, reply=self.draft, requiresReview=self.requires_review, orderCandidate=None)


_POLICY = EvidenceSource("application_policy", None, "currency.EGP")
_TEMPLATE = EvidenceSource("deterministic_template", None, "read_only_safety")
_AUTH = {RetrievalStatus.AUTHORIZATION_FAILED, RetrievalStatus.SCOPE_MISMATCH}
_UNSUPPORTED = {Intent.ORDER_STATUS, Intent.ORDER_MODIFY, Intent.ORDER_CANCEL, Intent.RETURNS_POLICY}


def _say(language, en, ar):
    return ar if language == "ar" else en


def _statement(kind, text, *sources, product_id=None, variant_id=None):
    return GroundedStatement(kind, text, sources or (_TEMPLATE,), product_id, variant_id)


def _index(result):
    """Read only typed envelopes; candidates/history cannot introduce facts.

    Later whole records replace earlier observations without merging fields.
    Product/variant identities may not change business or parent across records.
    """
    products, variants, businesses = {}, {}, []
    identities = {}
    invalid = False

    def add_product(product, source):
        nonlocal invalid
        old = identities.setdefault(("product", product.id), (product.businessId,))
        if old != (product.businessId,):
            raise PermissionError
        products[product.id] = (product, source)
        for index, variant in enumerate(product.variants):
            if variant.catalogItemId != product.id or variant.businessId != product.businessId:
                raise PermissionError
            add_variant(variant, EvidenceSource(source.tool, source.envelope_index, source.path + f".variants[{index}]"))

    def add_variant(variant, source):
        old = identities.setdefault(("variant", variant.id), (variant.businessId, variant.catalogItemId))
        if old != (variant.businessId, variant.catalogItemId):
            raise PermissionError
        variants[variant.id] = (variant, source)

    for index, outcome in enumerate(result.evidence):
        if outcome.status in _AUTH:
            raise PermissionError
        if outcome.envelope is None:
            continue
        tool, data = outcome.envelope.tool, outcome.envelope.data
        source = EvidenceSource(tool, index, "data")
        try:
            if tool == "get_product_details" and isinstance(data, Product):
                add_product(Product.model_validate(data.model_dump(mode="json")), source)
            elif tool == "get_variant_details" and isinstance(data, ProductVariant):
                add_variant(ProductVariant.model_validate(data.model_dump(mode="json")), source)
            elif tool in {"get_products", "get_product_variants"} and isinstance(data, Page):
                model = Product if tool == "get_products" else ProductVariant
                # Validate the entire page before admitting any of its records.
                parsed = Page[model].model_validate(data.model_dump(mode="json"))
                for position, item in enumerate(parsed.items):
                    item_source = EvidenceSource(tool, index, f"data.items[{position}]")
                    (add_product if model is Product else add_variant)(item, item_source)
            elif tool == "get_business_info" and isinstance(data, BusinessInformation):
                businesses.append((BusinessInformation.model_validate(data.model_dump(mode="json")), source))
            else:
                invalid = True
        except ValidationError:
            invalid = True
    business_ids = {p.businessId for p, _ in products.values()} | {v.businessId for v, _ in variants.values()} | {b.business.id for b, _ in businesses}
    if len(business_ids) > 1:
        raise PermissionError
    for variant, _ in variants.values():
        if variant.catalogItemId in products and products[variant.catalogItemId][0].businessId != variant.businessId:
            raise PermissionError
    return products, variants, businesses, invalid


class EvidencePlanner:
    """Stateless injectable planner; scoped retrieval is its trusted input boundary."""
    def plan(self, inquiry: str | RetrievalQuery, result: RetrievalResult,
             history: PreparedHistory | None = None) -> EvidencePlan:
        query = PlanningInquiry(text=inquiry) if isinstance(inquiry, str) else inquiry
        language = detect_language(query.text)
        entities = extract_entities(query.text)
        route = route_current_inquiry(query.text)
        intent = route.intents[0] if route.intents else Intent.UNKNOWN
        purchase = intent == Intent.CREATE_ORDER
        e03 = E03Intent.PURCHASE_INTENT if purchase else E03Intent.INQUIRY
        review = intent in OWNER_REVIEW_INTENTS or intent == Intent.COMPLAINT
        base = dict(intent=e03, language=language, requires_review=review,
                    requested_quantity=entities.quantity, catalog_coverage=result.catalog_coverage,
                    variant_coverage=result.variant_coverage)

        def simple(resolution, kind, en, ar, *, missing=(), limitations=()):
            references = []
            if resolution not in {Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH}:
                references.extend(CandidateReference(identifier, None, "request", False) for identifier in query.product_ids)
                references.extend(CandidateReference(ref.product_id, ref.variant_id, "request", False) for ref in query.variant_references)
                if history is not None and is_contextual_followup(query.text):
                    references.extend(CandidateReference(h.product_id, h.variant_id, "history", False)
                                      for h in history.references if h.product_id is not None)
            return EvidencePlan(**base, resolution=resolution, missing_facts=missing, limitations=limitations,
                                references=tuple(references),
                                requires_clarification=resolution in {Resolution.CLARIFY, Resolution.MISSING_DETAIL, Resolution.NO_MATCH_EXHAUSTED, Resolution.NO_MATCH_PARTIAL},
                                statements=(_statement(kind, _say(language, en, ar)),))

        failure = result.failure or result.status
        if failure in _AUTH or (history and history.failure in _AUTH):
            rejected = failure if failure in _AUTH else history.failure
            return simple(Resolution.AUTHORIZATION_FAILED if rejected == RetrievalStatus.AUTHORIZATION_FAILED else Resolution.SCOPE_MISMATCH,
                          "authorization_unavailable", "I cannot verify that information here.", "مش قادر أتحقق من المعلومات دي هنا.", limitations=("authorization_rejected",))
        if result.inquiry is not None and query != result.inquiry:
            return simple(Resolution.MISSING_DETAIL, "information_unverified",
                          "The requested selections changed; current matching details need verification.",
                          "الاختيارات المطلوبة اتغيرت؛ محتاج أتحقق من التفاصيل المطابقة الحالية.",
                          missing=("inquiry_selection_mismatch",), limitations=("retrieval_inquiry_mismatch",))
        if intent in OWNER_REVIEW_INTENTS or intent == Intent.COMPLAINT:
            base["intent"] = E03Intent.OTHER
            key = "COMPLAINT_GENERIC" if intent == Intent.COMPLAINT else intent.value
            return simple(Resolution.SIMPLE_RESPONSE, "owner_review", t("en", key), t("ar", key))
        if intent in {Intent.GREETING, Intent.THANKYOU} and result.decision == RetrievalDecision.SKIP:
            base["intent"] = E03Intent.OTHER
            key = "GREETING_SALAM" if intent == Intent.GREETING and "سلام عليكم" in normalize(query.text) else intent.value
            return simple(Resolution.SIMPLE_RESPONSE, "hard_rule", t("en", intent.value), t("ar", key))
        if intent == Intent.HELP:
            return simple(Resolution.SIMPLE_RESPONSE, "help", "I can help identify products and explain recorded prices and stock. I cannot create or change orders.",
                          "أقدر أساعدك تحدد المنتجات وأوضح الأسعار والمخزون المسجل. مش بقدر أنشئ أو أعدل طلبات.")
        if intent in _UNSUPPORTED or result.decision == RetrievalDecision.UNSUPPORTED:
            return simple(Resolution.UNSUPPORTED, "unsupported", "I don't have confirmed information or an action available for that.",
                          "معنديش معلومات مؤكدة أو إجراء متاح بخصوص ده.", missing=("unsupported_policy_or_action",))
        try:
            products, variants, businesses, invalid = _index(result)
        except PermissionError:
            return simple(Resolution.SCOPE_MISMATCH, "scope_mismatch", "I cannot verify that information here.",
                          "مش قادر أتحقق من المعلومات دي هنا.", limitations=("inconsistent_scope",))
        if result.decision == RetrievalDecision.BUSINESS and businesses:
            business, source = businesses[-1]
            return EvidencePlan(**base, resolution=Resolution.BUSINESS_INFO, statements=(
                _statement("business_identity", _say(language, f'Business name: "{business.business.name}".', f'اسم النشاط: "{business.business.name}".'), source),))
        limitations = ["recorded_observations_not_reservations", "no_stable_snapshot"]
        if result.inquiry is None:
            # Compatibility for earlier isolated, manually built component fixtures.
            # The assembled flow refuses results without an exact inquiry binding.
            limitations.append("unbound_retrieval_inquiry")
        if result.catalog_coverage == SearchCoverage.PARTIAL:
            limitations.append("partial_catalog_not_globally_unique")
        if result.failure:
            limitations.append("retrieval_failure")
        if invalid:
            limitations.append("invalid_evidence_omitted")
        wanted = {p.id for p in result.candidates} | set(query.product_ids) | {r.product_id for r in query.variant_references}
        wanted.update(identifier for identifier, (_, source) in products.items() if source.tool == "get_product_details")
        chosen = [(p, source) for identifier, (p, source) in products.items() if identifier in wanted]
        if not chosen:
            resolution = (Resolution.INVALID if invalid or failure == RetrievalStatus.INVALID else
                          Resolution.UNAVAILABLE if failure == RetrievalStatus.UNAVAILABLE else
                          Resolution.MISSING_DETAIL if wanted or any(v.catalogItemId not in products for v, _ in variants.values()) else
                          Resolution.NO_MATCH_EXHAUSTED if result.catalog_coverage == SearchCoverage.EXHAUSTED else Resolution.NO_MATCH_PARTIAL)
            unavailable = resolution in {Resolution.UNAVAILABLE, Resolution.INVALID}
            return simple(resolution, "information_unverified",
                          "Current product information could not be verified." if unavailable else "I couldn't verify a matching product in the retrieved information. Which product do you mean?",
                          "مش قادر أتحقق من معلومات المنتج الحالية." if unavailable else "مش قادر أتحقق من منتج مطابق في المعلومات اللي وصلت. تقصد أنهي منتج؟",
                          missing=("product_detail",), limitations=tuple(limitations))
        product_facts, variant_facts, statements, missing, ambiguities = [], [], [], [], []
        matching = []
        inactive_match = False
        active_products = [p for p, _ in chosen if p.isActive]
        coverage = {item.product_id: item.coverage for item in result.variant_coverage}
        explicit_variants = {ref.variant_id for ref in query.variant_references}
        for product, source in chosen:
            product_facts.append(ProductFact(product.id, product.businessId, product.name, product.basePrice,
                                            product.isActive, product.isSellable,
                                            tuple((k, tuple(v)) for k, v in product.options.items()), source))
            statements.append(_statement("product_identity", _say(language, f'Product: "{product.name}".', f'المنتج: "{product.name}".'), source, product_id=product.id))
            if not product.isActive:
                statements.append(_statement("inactive_product", _say(language, "This product is inactive; it is not offered for purchase.", "المنتج ده غير نشط ومش معروض للشراء."), source, product_id=product.id))
            selection = resolve_options(product, query.text, query.option_values, query.option_alternatives)
            if selection.unresolved:
                ambiguities.append("unresolved_option_request")
            observations = [(v, s) for v, s in variants.values() if v.catalogItemId == product.id]
            if not observations:
                missing.append("variant_detail")
            for variant, variant_source in observations:
                verified_options = variant_options_valid(product, variant)
                variant_facts.append(VariantFact(product.id, variant.id, tuple(variant.optionValues.items()), variant.effectivePrice,
                                                 APPLICATION_CURRENCY, variant.inventory_state, variant.stockQuantity,
                                                 variant.isActive, product.isActive, verified_options, variant_source, source))
                relevant = not explicit_variants or variant.id in explicit_variants
                matched = relevant and variant_matches_options(product, variant, selection)
                if relevant and not verified_options:
                    missing.append("variant_option_metadata")
                if matched or (relevant and not selection.values):
                    if variant.effectivePrice is None:
                        missing.append("variant_price")
                    if not variant.trackInventory:
                        missing.append("confirmed_availability")
                if matched and (not product.isActive or not variant.isActive):
                    inactive_match = True
                    if product.isActive:
                        statements.append(_statement("inactive_variant", _say(language, "This matching variant is inactive; it is not offered for purchase.",
                            "الاختيار المطابق ده غير نشط ومش معروض للشراء."), source, variant_source, product_id=product.id, variant_id=variant.id))
                if matched and product.isActive and variant.isActive:
                    matching.append(variant.id)
                if not product.isActive or not variant.isActive:
                    continue
                if not matched:
                    continue
                label = ", ".join(f'{k}="{v}"' for k, v in variant.optionValues.items())
                price = (f"{variant.effectivePrice:.2f} EGP" if variant.effectivePrice is not None else
                         _say(language, "price unconfirmed", "السعر غير مؤكد"))
                inventory = (_say(language, "recorded stock: 0; no recorded stock remains", "الكمية المسجلة: 0؛ مفيش مخزون مسجل متبقي") if variant.trackInventory and variant.stockQuantity == 0 else
                             _say(language, f"recorded stock: {variant.stockQuantity}", f"الكمية المسجلة: {variant.stockQuantity}")
                             if variant.trackInventory else _say(language, "inventory untracked; availability unconfirmed", "المخزون غير متتبع والتوافر غير مؤكد"))
                statements.append(_statement("variant_observation", f'"{product.name}" [{label}]: {price}; {inventory}.',
                                             source, variant_source, _POLICY, product_id=product.id, variant_id=variant.id))
            if coverage.get(product.id, SearchCoverage.NOT_SEARCHED) != SearchCoverage.EXHAUSTED:
                limitations.append("variant_search_incomplete")
            if not product.isSellable:
                limitations.append("product_not_metadata_sellable")
        followup = is_contextual_followup(query.text)
        if history is not None and followup:
            limitations.append("provisional_history")
        references = [CandidateReference(p.id, None, "retrieval", p.id in products) for p in result.candidates]
        if history is not None and followup:
            references.extend(CandidateReference(h.product_id, h.variant_id, "history",
                h.product_id in products and (h.variant_id is None or h.variant_id in variants and variants[h.variant_id][0].catalogItemId == h.product_id))
                for h in history.references if h.product_id is not None)
        if len(active_products) > 1:
            resolution = Resolution.PRODUCT_AMBIGUITY
            ambiguities.append("multiple_products")
        elif not active_products:
            resolution = Resolution.INACTIVE
        elif selection.unresolved:
            resolution = Resolution.CLARIFY
        elif len(matching) == 1:
            resolution = Resolution.SINGLE_VARIANT
        elif len(matching) > 1:
            resolution = Resolution.MULTIPLE_VARIANTS
            ambiguities.append("multiple_variants")
        elif inactive_match:
            resolution = Resolution.INACTIVE
        elif "variant_option_metadata" in missing:
            resolution = Resolution.MISSING_DETAIL
        elif not variant_facts:
            resolution = Resolution.MISSING_DETAIL
        elif all(not v.active for v in variant_facts):
            resolution = Resolution.INACTIVE
        else:
            resolution = Resolution.NO_MATCH_EXHAUSTED if all(coverage.get(p.id) == SearchCoverage.EXHAUSTED for p in active_products) else Resolution.NO_MATCH_PARTIAL
        clarify = bool(result.needs_clarification or followup or ambiguities or len(matching) != 1
                       or result.catalog_coverage == SearchCoverage.PARTIAL or missing or result.failure or invalid
                       or (not explicit_variants and any(coverage.get(p.id) != SearchCoverage.EXHAUSTED for p in active_products)))
        if not explicit_variants and any(p.options and not resolve_options(p, query.text, query.option_values, query.option_alternatives).values for p in active_products):
            clarify = True
        if clarify:
            keys = [key for product in active_products for key in product.options
                    if key not in dict(resolve_options(product, query.text, query.option_values, query.option_alternatives).values)]
            question = (_say(language, "Which product do you mean?", "تقصد أنهي منتج؟") if len(active_products) != 1 or followup or result.catalog_coverage == SearchCoverage.PARTIAL else
                        _say(language, "Please specify " + ", ".join(dict.fromkeys(keys)) + ".", "ممكن تحدد " + "، ".join(dict.fromkeys(keys)) + "؟") if keys else
                        _say(language, "Current variant details could not be fully verified.", "مش قادر أتحقق من كل تفاصيل الاختيار الحالي.") if missing or result.failure or invalid else
                        _say(language, "Which variant do you mean? Availability is unconfirmed.", "تقصد أنهي اختيار؟ التوافر غير مؤكد."))
            statements.append(_statement("clarification", question))
        statements.append(_statement("observation_limit", _say(language, "Recorded information only; stock may change. No reservation is made.",
                                      "دي بيانات مسجلة؛ المخزون ممكن يتغير، ومفيش حجز.")))
        selected_fact = next((v for v in variant_facts if len(matching) == 1 and v.variant_id == matching[0]), None)
        selected = matching[0] if (selected_fact and not clarify and active_products[0].isSellable
                                   and selected_fact.effective_price is not None and selected_fact.inventory == InventoryState.RECORDED_POSITIVE) else None
        return EvidencePlan(**base, resolution=resolution, products=tuple(product_facts), variants=tuple(variant_facts),
                            references=tuple(references), matching_variant_ids=tuple(matching), selected_variant_id=selected,
                            requires_clarification=clarify, missing_facts=tuple(dict.fromkeys(missing)),
                            ambiguities=tuple(dict.fromkeys(ambiguities)), limitations=tuple(dict.fromkeys(limitations)),
                            statements=tuple(statements))
