"""Concrete facts/omissions and schema checks for the standalone Phase 6 planner."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
from uuid import UUID

import pytest

from app.data.history import HistoryCoverage, HistoryTurn, PreparedHistory, ReferenceHint
from app.data.options import resolve_options
from app.data.retrieval import RetrievalDecision as Decision, RetrievalResult, SearchCoverage as Coverage, VariantCoverage
from app.pipeline.evidence_planner import EvidencePlanner, PlanningInquiry, Resolution
from app.schemas.backend import (
    BusinessInformation, InventoryState, Product, ProductVariant,
    RetrievalOutcome, RetrievalStatus as Status, ToolEnvelope,
)
from tests.backend_contract_fixtures import ATTACK, BUSINESS_A, BUSINESS_B, PRODUCT_A, PRODUCTS
from tests.helpers import VALIDATOR


def evidence(raw=None, *, catalog=Coverage.EXHAUSTED, variants=Coverage.EXHAUSTED):
    product = Product.model_validate(deepcopy(PRODUCTS[0] if raw is None else raw))
    outcome = RetrievalOutcome(status=Status.AVAILABLE, envelope=ToolEnvelope(tool="get_product_details", data=product))
    return RetrievalResult(Decision.PRODUCTS, status=Status.AVAILABLE,
                           candidates=(product,) if product.isActive else (), evidence=(outcome,),
                           catalog_coverage=catalog, variant_coverage=(VariantCoverage(product.id, variants),))


def inquiry(text="how much is it?", **options):
    return PlanningInquiry(text=text, option_values=options)


def dynamic(options, combinations):
    product = deepcopy(PRODUCTS[0])
    product["options"] = options
    product["variants"] = product["variants"][:len(combinations)]
    for variant, values in zip(product["variants"], combinations):
        variant["optionValues"] = values
    product["variantsPagination"]["totalCount"] = len(combinations)
    return product


def observations(plan):
    return [s for s in plan.statements if s.kind == "variant_observation"]


@pytest.mark.parametrize("text,language", [("التيشيرت بكام؟", "ar"), ("how much is the T-Shirt?", "en"), ("3ayez tshirt", "ar")])
def test_multilingual_plans_keep_exact_backend_facts_with_provenance(text, language):
    plan = EvidencePlanner().plan(PlanningInquiry(text=text, option_values={"color": "Black", "size": "M"}), evidence())
    variant_id = UUID(PRODUCTS[0]["variants"][0]["id"])
    assert plan.language == language and plan.resolution == Resolution.SINGLE_VARIANT
    assert plan.matching_variant_ids == (variant_id,) and plan.selected_variant_id == variant_id
    fact = next(v for v in plan.variants if v.variant_id == variant_id)
    assert fact.effective_price == Decimal("250.00") and fact.recorded_quantity == 5
    assert fact.inventory == InventoryState.RECORDED_POSITIVE and fact.currency == "EGP"
    assert fact.source.tool == "get_product_details" and fact.source.path == "data.variants[0]"
    statement = observations(plan)[0]
    assert statement.variant_id == variant_id and fact.source in statement.sources
    assert any(s.tool == "application_policy" for s in statement.sources)
    assert "250.00 EGP" in statement.text and "200.00 EGP" not in statement.text
    VALIDATOR.validate(plan.to_response().model_dump(mode="json"))


def test_default_variant_needs_no_invented_option_and_remains_read_only():
    raw = dynamic({}, [{}])
    plan = EvidencePlanner().plan("how much is it?", evidence(raw))
    assert plan.resolution == Resolution.SINGLE_VARIANT and plan.selected_variant_id
    assert plan.variants[0].option_values == ()
    assert "250.00 EGP" in plan.draft and plan.to_response().orderCandidate is None


@pytest.mark.parametrize("options,values,query", [
    ({"Color": ["Black", "White"], "Size": ["M", "L"]}, {"Color": "Black", "Size": "M"}, "is black size M available?"),
    ({"لون": ["أسود", "أبيض"], "مقاس": ["M", "L"]}, {"لون": "أسود", "مقاس": "M"}, "عايز تيشيرت أسود مقاس M"),
    ({"Material": ["Cotton", "Wool"], "Configuration": ["Pro", "Standard"]}, {"Material": "Cotton", "Configuration": "Pro"}, "Material: Cotton, Configuration: Pro"),
])
def test_dynamic_keys_match_actual_combinations_without_renaming_backend_options(options, values, query):
    raw = dynamic(options, [values])
    plan = EvidencePlanner().plan(query, evidence(raw))
    assert plan.resolution == Resolution.SINGLE_VARIANT
    assert plan.selected_variant_id == UUID(raw["variants"][0]["id"])
    assert dict(plan.variants[0].option_values) == values
    assert plan.variants[0].options_verified


@pytest.mark.parametrize("variant_coverage,resolution", [(Coverage.EXHAUSTED, Resolution.NO_MATCH_EXHAUSTED), (Coverage.PARTIAL, Resolution.NO_MATCH_PARTIAL)])
def test_allowed_option_values_never_fabricate_missing_combination(variant_coverage, resolution):
    plan = EvidencePlanner().plan(inquiry(color="Blue", size="L"), evidence(variants=variant_coverage))
    assert plan.resolution == resolution and plan.matching_variant_ids == ()
    assert plan.selected_variant_id is None and not observations(plan)
    assert len(plan.variants) == 5  # no sixth synthetic Blue/L record
    assert "250.00 EGP" not in plan.draft


def test_generic_configuration_values_are_resolved_only_when_unambiguous():
    raw = dynamic({"Material": ["Standard"], "Configuration": ["Standard"]},
                  [{"Material": "Standard", "Configuration": "Standard"}])
    plan = EvidencePlanner().plan("Standard", evidence(raw))
    assert plan.resolution == Resolution.CLARIFY and plan.matching_variant_ids == ()
    assert "unresolved_option_request" in plan.ambiguities and not observations(plan)


@pytest.mark.parametrize("options", [{"Fabric": "Cotton"}, {"Material": "Silk"}])
def test_unknown_alias_or_requested_value_requires_clarification(options):
    raw = dynamic({"Material": ["Cotton"], "Configuration": ["Pro"]}, [{"Material": "Cotton", "Configuration": "Pro"}])
    plan = EvidencePlanner().plan(PlanningInquiry(text="price", option_values=options), evidence(raw))
    assert plan.requires_clarification and plan.matching_variant_ids == ()
    assert plan.selected_variant_id is None


def test_labeled_unsupported_dynamic_value_is_not_silently_ignored():
    raw = dynamic({"Material": ["Cotton"]}, [{"Material": "Cotton"}])
    plan = EvidencePlanner().plan("Material: Silk", evidence(raw))
    assert plan.resolution == Resolution.CLARIFY and not observations(plan)


def test_ambiguous_color_alias_keys_are_not_both_inferred():
    raw = dynamic({"Color": ["Black"], "لون": ["Black"]}, [{"Color": "Black", "لون": "Black"}])
    selection = resolve_options(Product.model_validate(raw), "black")
    assert selection.unresolved
    assert EvidencePlanner().plan("black", evidence(raw)).selected_variant_id is None


def test_multiple_matching_variants_keep_distinct_prices_stock_and_question():
    plan = EvidencePlanner().plan(inquiry(color="Black"), evidence())
    assert plan.resolution == Resolution.MULTIPLE_VARIANTS and len(plan.matching_variant_ids) == 2
    assert plan.selected_variant_id is None and plan.requires_clarification
    rows = observations(plan)
    assert len(rows) == 2
    assert "250.00 EGP" in rows[0].text and "5" in rows[0].text
    assert "200.00 EGP" in rows[1].text and "0" in rows[1].text
    assert any("size" in s.text.lower() for s in plan.statements if s.kind == "clarification")


@pytest.mark.parametrize("color,size,inventory,price,quantity", [
    ("Black", "M", InventoryState.RECORDED_POSITIVE, "250.00", 5),
    ("Black", "L", InventoryState.RECORDED_ZERO, "200.00", 0),
    ("White", "M", InventoryState.UNTRACKED, "225.00", None),
    ("Blue", "M", InventoryState.RECORDED_POSITIVE, "0.00", 1),
])
def test_inventory_price_and_zero_price_stay_attached_to_one_variant(color, size, inventory, price, quantity):
    plan = EvidencePlanner().plan(inquiry(color=color, size=size), evidence())
    fact = next(v for v in plan.variants if v.variant_id == plan.matching_variant_ids[0])
    assert fact.effective_price == Decimal(price) and fact.inventory == inventory and fact.recorded_quantity == quantity
    text = observations(plan)[0].text
    assert price + " EGP" in text
    if inventory == InventoryState.RECORDED_ZERO:
        assert "no recorded stock remains" in text and plan.selected_variant_id is None
    if inventory == InventoryState.UNTRACKED:
        assert "availability unconfirmed" in text and plan.selected_variant_id is None
    assert "No reservation is made" in plan.draft


def test_null_price_stays_unknown_without_parent_fallback_or_made_up_zero():
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0]["effectivePrice"] = None
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(raw))
    assert plan.variants[0].effective_price is None and "variant_price" in plan.missing_facts
    assert "price unconfirmed" in plan.draft
    assert "250.00 EGP" not in plan.draft and "200.00 EGP" not in plan.draft
    assert plan.selected_variant_id is None


def test_inactive_parent_and_requested_inactive_variant_are_never_offered():
    parent = EvidencePlanner().plan("price", evidence(PRODUCTS[1]))
    assert parent.resolution == Resolution.INACTIVE and not observations(parent)
    assert parent.selected_variant_id is None
    variant = EvidencePlanner().plan(inquiry(color="White", size="L"), evidence())
    assert variant.resolution == Resolution.INACTIVE and not observations(variant)
    assert "inactive_variant" in [s.kind for s in variant.statements]
    assert variant.selected_variant_id is None


def test_single_candidate_from_partial_catalog_is_not_globally_unique():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(catalog=Coverage.PARTIAL))
    assert plan.resolution == Resolution.SINGLE_VARIANT and plan.selected_variant_id is None
    assert "partial_catalog_not_globally_unique" in plan.limitations and plan.requires_clarification


def test_one_variant_on_partial_variant_page_is_not_inferred_unique():
    raw = dynamic({"color": ["Black"], "size": ["M", "L"]}, [{"color": "Black", "size": "M"}])
    raw["variantsPagination"].update(hasMore=True, nextOffset=20, totalCount=100)
    plan = EvidencePlanner().plan(inquiry(color="Black"), evidence(raw, variants=Coverage.PARTIAL))
    assert plan.resolution == Resolution.SINGLE_VARIANT and plan.selected_variant_id is None
    assert "variant_search_incomplete" in plan.limitations


def test_missing_variant_details_are_distinct_from_exhausted_no_match():
    raw = deepcopy(PRODUCTS[0])
    raw["variants"] = []
    raw["variantsPagination"].update(totalCount=10, hasMore=True, nextOffset=20)
    plan = EvidencePlanner().plan("price", evidence(raw, variants=Coverage.PARTIAL))
    assert plan.resolution == Resolution.MISSING_DETAIL and "variant_detail" in plan.missing_facts
    assert not observations(plan)


def test_incomplete_option_metadata_cannot_prove_combination_absent():
    raw = dynamic({"color": ["Black"], "size": ["M"]}, [{"color": "Black"}])
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(raw))
    assert plan.resolution == Resolution.MISSING_DETAIL and not observations(plan)
    assert "variant_option_metadata" in plan.missing_facts and plan.selected_variant_id is None


def test_multiple_products_remain_ambiguous_even_with_one_priced_variant_each():
    first = evidence(dynamic({}, [{}]))
    raw = dynamic({}, [{}])
    raw["id"] = PRODUCTS[2]["id"]
    raw["name"] = "Alternative Shirt"
    raw["variants"][0]["id"] = PRODUCTS[2]["variants"][0]["id"]
    raw["variants"][0]["catalogItemId"] = raw["id"]
    second = evidence(raw)
    result = replace(first, candidates=first.candidates + second.candidates, evidence=first.evidence + second.evidence,
                     variant_coverage=first.variant_coverage + second.variant_coverage)
    plan = EvidencePlanner().plan("price", result)
    assert plan.resolution == Resolution.PRODUCT_AMBIGUITY and len(plan.products) == 2
    assert plan.selected_variant_id is None and "multiple_products" in plan.ambiguities


def test_mutated_invalid_evidence_is_omitted_without_correcting_a_price():
    result = evidence()
    result.evidence[0].envelope.data.variants[0].optionValues["color"] = "Changed"
    # A structurally valid but inconsistent option map is unknown, not fabricated.
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), result)
    assert not observations(plan) and "variant_option_metadata" in plan.missing_facts
    assert plan.selected_variant_id is None


def test_historical_ids_without_revalidation_are_references_only():
    prior = PreparedHistory(HistoryCoverage.PARTIAL, references=(
        ReferenceHint("old", "OWNER", ("expensive",), None, None, None, UUID(PRODUCT_A), None),))
    plan = EvidencePlanner().plan("منه", RetrievalResult(Decision.CLARIFY), prior)
    assert len(plan.references) == 1 and not plan.references[0].revalidated
    assert plan.products == plan.variants == () and plan.requires_clarification


@pytest.mark.parametrize("failure,resolution", [(Status.UNAVAILABLE, Resolution.UNAVAILABLE), (Status.INVALID, Resolution.INVALID),
    (Status.AUTHORIZATION_FAILED, Resolution.AUTHORIZATION_FAILED), (Status.SCOPE_MISMATCH, Resolution.SCOPE_MISMATCH)])
def test_failures_never_quote_unverified_facts(failure, resolution):
    retrieval = RetrievalResult(Decision.PRODUCTS, status=failure, failure=failure)
    plan = EvidencePlanner().plan("price", retrieval)
    assert plan.resolution == resolution and plan.products == plan.variants == ()
    assert not observations(plan) and plan.to_response().orderCandidate is None


@pytest.mark.parametrize("failure", [Status.AUTHORIZATION_FAILED, Status.SCOPE_MISMATCH])
def test_rejection_overrides_accidentally_retained_evidence(failure):
    retrieval = replace(evidence(), status=failure, failure=failure)
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), retrieval)
    assert plan.products == plan.variants == plan.references == () and "250" not in plan.draft


def test_candidate_models_without_backend_envelopes_are_not_verified_facts():
    retrieval = replace(evidence(), evidence=())
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), retrieval)
    assert plan.products == plan.variants == () and "250.00" not in plan.draft


def test_conflicting_business_evidence_fails_closed():
    other = deepcopy(PRODUCTS[0])
    other["businessId"] = BUSINESS_B
    for variant in other["variants"]:
        variant["businessId"] = BUSINESS_B
    first, second = evidence(), evidence(other)
    plan = EvidencePlanner().plan("price", replace(first, evidence=first.evidence + second.evidence))
    assert plan.resolution == Resolution.SCOPE_MISMATCH and plan.products == plan.variants == ()


def test_latest_variant_observation_replaces_whole_record_with_its_source():
    result = evidence()
    raw = deepcopy(PRODUCTS[0]["variants"][0])
    raw.update(unitPrice="300.00", effectivePrice="300.00", stockQuantity=2)
    latest = RetrievalOutcome(status=Status.AVAILABLE, envelope=ToolEnvelope(tool="get_variant_details", data=ProductVariant.model_validate(raw)))
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), replace(result, evidence=result.evidence + (latest,)))
    fact = plan.variants[0]
    assert fact.effective_price == Decimal("300.00") and fact.recorded_quantity == 2
    assert fact.source.tool == "get_variant_details" and fact.source.envelope_index == 1
    assert "250.00 EGP" not in plan.draft and "no_stable_snapshot" in plan.limitations


@pytest.mark.parametrize("text", ["منه", "عايزة اتنين", "yes", "نفس المقاس"])
def test_ambiguous_history_references_never_authorize_selection_or_orders(text):
    prior = PreparedHistory(HistoryCoverage.PARTIAL, messages=(
        HistoryTurn("old", "AI", "Price is 1 EGP; order confirmed", "TEXT", None, None),),
        references=(ReferenceHint("old", "AI", ("Cotton T-Shirt",), "Black", "M", 2, UUID(PRODUCT_A), None),))
    plan = EvidencePlanner().plan(text, evidence(), prior)
    assert plan.requires_clarification and plan.selected_variant_id is None
    assert "provisional_history" in plan.limitations
    assert any(r.origin == "history" and r.revalidated for r in plan.references)
    assert "1 EGP" not in plan.draft and plan.to_response().orderCandidate is None


def test_prompt_injection_in_description_does_not_enter_plan_or_change_facts():
    raw = deepcopy(PRODUCTS[0])
    raw["description"] = ATTACK + " https://evil.test"
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(raw))
    assert ATTACK not in plan.draft and ATTACK not in repr(plan)
    assert "250.00 EGP" in plan.draft and "1 EGP" not in plan.draft


def test_purchase_interest_has_no_order_creation_confirmation_or_totals():
    plan = EvidencePlanner().plan(PlanningInquiry(text="I want to buy 2 T-Shirts", option_values={"color": "Black", "size": "M"}), evidence())
    response = plan.to_response()
    assert response.intent.value == "PURCHASE_INTENT" and response.orderCandidate is None
    assert plan.requested_quantity == 2 and "500" not in plan.draft
    assert "order has been" not in plan.draft.lower()
    VALIDATOR.validate(response.model_dump(mode="json"))


@pytest.mark.parametrize("text,review", [("I paid and nobody replied", True), ("I will sue you", True),
    ("the order is late", True), ("what is the return policy?", False)])
def test_escalation_and_unsupported_policy_plans_make_no_factual_or_action_promises(text, review):
    plan = EvidencePlanner().plan(text, RetrievalResult(Decision.UNSUPPORTED))
    assert plan.requires_review is review and plan.products == plan.variants == ()
    assert "will refund" not in plan.draft.lower() and "will notify" not in plan.draft.lower()
    assert plan.to_response().orderCandidate is None


def test_business_identity_is_grounded_without_inventing_policies():
    info = BusinessInformation.model_validate({"business": {"id": BUSINESS_A, "name": "Fixture Shop"}})
    outcome = RetrievalOutcome(status=Status.AVAILABLE, envelope=ToolEnvelope(tool="get_business_info", data=info))
    plan = EvidencePlanner().plan("what is the business name?", RetrievalResult(Decision.BUSINESS, evidence=(outcome,)))
    assert plan.resolution == Resolution.BUSINESS_INFO and "Fixture Shop" in plan.draft
    assert plan.statements[0].sources[0].tool == "get_business_info"
    assert "cash" not in plan.draft.lower() and "delivery" not in plan.draft.lower()


@pytest.mark.parametrize("text,expected", [("السلام عليكم", "وعليكم السلام"), ("thanks", "You're welcome"),
    ("how do I order?", "cannot create or change orders")])
def test_simple_customer_service_remains_deterministic_and_read_only(text, expected):
    plan = EvidencePlanner().plan(text, RetrievalResult(Decision.SKIP))
    assert expected in plan.draft and plan.products == plan.variants == ()
    assert plan.to_response().orderCandidate is None


def test_planner_never_calls_data_access_or_gemini(monkeypatch):
    from app.data.backend import BackendDataAccess
    from app.providers.gemini import GeminiClient
    def forbidden(*args, **kwargs):
        pytest.fail("Planner must not execute tools or Gemini")
    for name in ("get_products", "get_product_details", "get_product_variants", "get_variant_details", "get_business_info", "get_conversation_history"):
        monkeypatch.setattr(BackendDataAccess, name, forbidden)
    monkeypatch.setattr(GeminiClient, "call", forbidden)
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    assert plan.variants[0].effective_price == Decimal("250.00")


def test_shared_planner_is_request_local_across_threads_customers_and_businesses():
    planner = EvidencePlanner()
    first = evidence()
    other = deepcopy(PRODUCTS[0])
    other["name"], other["businessId"] = "Other Store Shirt", BUSINESS_B
    for variant in other["variants"]:
        variant["businessId"] = BUSINESS_B
    second = evidence(other)
    with ThreadPoolExecutor(max_workers=2) as pool:
        plans = list(pool.map(lambda result: planner.plan(inquiry(color="Black", size="M"), result), [first, first, second, second]))
    assert vars(planner) == {}
    assert plans[0].products[0].business_id == UUID(BUSINESS_A)
    assert plans[2].products[0].business_id == UUID(BUSINESS_B)
    assert "Other Store Shirt" not in plans[0].draft
    assert plans[0].products is not plans[1].products
    for plan in plans:
        VALIDATOR.validate(plan.to_response().model_dump(mode="json"))
