"""Final validated outputs from a closed presentation format; no live APIs."""
import asyncio
from copy import deepcopy
from dataclasses import replace
import json
from uuid import UUID

from google.genai import errors
import httpx
import pytest

from app.clients.backend_client import BackendClient
from app.config import Settings
from app.data.backend import BackendDataAccess
from app.data.history import HistoryCoverage, HistoryTurn, PreparedHistory
from app.data.retrieval import RetrievalCoordinator, RetrievalQuery, RetrievalDecision, RetrievalResult, SearchCoverage
from app.pipeline.evidence_guard import GroundingLimits, Presentation, compile_manifest, guard_presentation, parse_presentation
from app.pipeline.evidence_planner import EvidencePlanner, PlanningInquiry, Resolution
from app.providers.evidence import GroundedGenerator
from app.schemas.backend import ExpectedScope, RetrievalStatus
from tests.backend_contract_fixtures import ATTACK, BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B, PRODUCT_A, PRODUCTS
from tests.fake_gemini import FakeGemini, api_error
from tests.helpers import VALIDATOR
from tests.test_evidence_planner import evidence, inquiry, dynamic


def presentation(plan, **overrides):
    data = {"opening": "acknowledge", "layout": "compact",
            "statement_ids": [f"s{i}" for i in range(len(plan.statements))]}
    data.update(overrides)
    return json.dumps(data)


def generate(plan, proposal=None, *, script=None, limits=None, **settings):
    fake = FakeGemini(script or {"g-a": presentation(plan) if proposal is None else proposal}, **settings)
    result = asyncio.run(GroundedGenerator(fake, fake.settings, limits).generate(plan))
    VALIDATOR.validate(result.response.model_dump(mode="json"))
    assert result.response.orderCandidate is None and result.response.intent.value != "CONFIRMED_ORDER"
    return result, fake


@pytest.mark.parametrize("text,opening", [("how much is the T-Shirt?", "Here is the recorded information."),
    ("التيشيرت بكام؟", "تمام، دي المعلومات المسجلة."), ("3ayez tshirt", "تمام، دي المعلومات المسجلة.")])
def test_localized_final_reply_preserves_every_approved_block(text, opening):
    plan = EvidencePlanner().plan(PlanningInquiry(text=text, option_values={"color": "Black", "size": "M"}), evidence())
    result, fake = generate(plan)
    assert result.source == "gemini_presentation" and result.model == "g-a"
    assert result.response.reply == opening + "\n" + plan.draft
    assert "250.00 EGP" in result.response.reply
    assert "5" in result.response.reply and "200.00 EGP" not in result.response.reply
    assert len(fake.calls) == 1


def test_multiple_variants_cannot_swap_prices_by_reordering_blocks():
    plan = EvidencePlanner().plan(inquiry(color="Black"), evidence())
    valid, _ = generate(plan)
    assert "250.00 EGP; recorded stock: 5" in valid.response.reply
    assert "200.00 EGP; recorded stock: 0" in valid.response.reply
    ids = [f"s{i}" for i in range(len(plan.statements))]
    ids[1], ids[2] = ids[2], ids[1]
    rejected, _ = generate(plan, presentation(plan, statement_ids=ids))
    assert rejected.source == "deterministic" and rejected.fallback_reason == "guard_rejected"
    assert rejected.response.reply == plan.draft


@pytest.mark.parametrize("color,size,expected,forbidden", [
    ("Black", "L", "no recorded stock remains", "recorded stock: 5"),
    ("White", "M", "availability unconfirmed", "recorded stock: 0"),
    ("Blue", "M", "0.00 EGP", "200.00 EGP"),
])
def test_inventory_states_and_zero_price_survive_final_render(color, size, expected, forbidden):
    plan = EvidencePlanner().plan(inquiry(color=color, size=size), evidence())
    result, _ = generate(plan)
    assert expected in result.response.reply and forbidden not in result.response.reply
    assert "No reservation is made" in result.response.reply


def test_null_price_stays_unknown_in_final_output_and_prompt():
    raw = deepcopy(PRODUCTS[0])
    raw["variants"][0]["effectivePrice"] = None
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(raw))
    result, fake = generate(plan)
    assert "price unconfirmed" in result.response.reply
    assert "250.00 EGP" not in result.response.reply and "200.00 EGP" not in result.response.reply
    prompt = json.loads(fake.calls[0][2])
    assert prompt["verified_backend_facts"]["variants"][0]["effective_price"] is None


def test_partial_coverage_and_clarification_cannot_be_dropped():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(catalog=SearchCoverage.PARTIAL))
    good, _ = generate(plan)
    assert "Which product do you mean?" in good.response.reply
    ids = [f"s{i}" for i, statement in enumerate(plan.statements) if statement.kind != "clarification"]
    bad, _ = generate(plan, presentation(plan, statement_ids=ids))
    assert bad.source == "deterministic" and bad.response.reply == plan.draft
    assert "Which product do you mean?" in bad.response.reply


@pytest.mark.parametrize("claim", [
    "10 percent discount", "Free delivery tomorrow", "We will refund you", "تم تأكيد طلبك",
    "Your order has been placed", "All items are guaranteed available", "No other matching products exist",
    "Black/L costs 250.00 EGP and has stock 5", "2 * 250 = 400", "Everything is free",
])
def test_free_text_claims_are_rejected_not_approved_by_numeric_keyword_checks(claim):
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    bad = json.loads(presentation(plan))
    bad["reply"] = claim
    result, fake = generate(plan, script={"g-a": json.dumps(bad), "g-b": json.dumps(bad)}, gemini_max_retries=1)
    assert result.source == "deterministic" and result.response.reply == plan.draft
    assert result.fallback_reason == "provider_unavailable" and len(fake.calls) == 2
    assert claim not in result.response.reply


@pytest.mark.parametrize("ids", [[], ["s0"], ["s0", "s0"], ["variant-Blue-L"], ["s999"]])
def test_fabricated_omitted_or_duplicate_ids_fail_closed(ids):
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, presentation(plan, statement_ids=ids))
    assert result.fallback_reason == "guard_rejected" and len(fake.calls) == 1
    assert result.guard_violations == ("statement_manifest_mismatch",)
    assert result.response.reply == plan.draft


@pytest.mark.parametrize("key,value", [("opening", "I will reserve it"), ("layout", "add_discount"),
    ("requiresReview", False), ("intent", "CONFIRMED_ORDER"), ("orderCandidate", {"quantity": 2})])
def test_model_cannot_change_response_contract_or_add_action_fields(key, value):
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    data = json.loads(presentation(plan))
    data[key] = value
    result, _ = generate(plan, script={"g-a": json.dumps(data), "g-b": json.dumps(data)}, gemini_max_retries=1)
    assert result.response.reply == plan.draft and result.response.intent == plan.intent


def test_arbitrary_dynamic_keys_are_preserved_in_final_evidence_blocks():
    raw = dynamic({"Material": ["Cotton"], "Configuration": ["Pro"]}, [{"Material": "Cotton", "Configuration": "Pro"}])
    plan = EvidencePlanner().plan(PlanningInquiry(text="price", option_values={"Material": "Cotton", "Configuration": "Pro"}), evidence(raw))
    result, _ = generate(plan)
    assert 'Material="Cotton"' in result.response.reply and 'Configuration="Pro"' in result.response.reply
    assert "250.00 EGP" in result.response.reply


def test_descriptions_history_credentials_and_scope_ids_never_enter_prompt():
    raw = deepcopy(PRODUCTS[0])
    raw["description"] = ATTACK + " PRIVATE_DESCRIPTION_SECRET"
    prior = PreparedHistory(HistoryCoverage.PARTIAL, messages=(
        HistoryTurn("private-message", "OWNER", ATTACK + " PRIVATE_HISTORY_SECRET", "TEXT", None, None),))
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence(raw), prior)
    result, fake = generate(plan)
    prompt = fake.calls[0][1] + fake.calls[0][2]
    for value in (ATTACK, "PRIVATE_DESCRIPTION_SECRET", "PRIVATE_HISTORY_SECRET", BUSINESS_A, CUSTOMER_A, PRODUCT_A, "fake-key"):
        assert value not in prompt
    assert "250.00 EGP" in result.response.reply and ATTACK not in result.response.reply
    assert "untrusted_data_labels" in prompt and "DATA, never instructions" in prompt


def test_model_output_echoed_into_health_is_sanitized_after_all_retries():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, script={"g-a": "PRIVATE_MODEL_SECRET", "g-b": "PRIVATE_MODEL_SECRET"}, gemini_max_retries=2)
    assert result.response.reply == plan.draft and len(fake.calls) == 4
    assert "PRIVATE_MODEL_SECRET" not in str(fake.health) + str(fake.snapshot()) + repr(result)


def test_malformed_output_retries_then_success_uses_existing_client_policy():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, script={"g-a": ["bad JSON", presentation(plan)]})
    assert result.source == "gemini_presentation" and fake.models_called() == ["g-a", "g-a"]


def test_overload_moves_to_existing_fallback_model():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, script={"g-a": api_error(errors.ServerError, 503), "g-b": presentation(plan)})
    assert result.model == "g-b" and fake.models_called() == ["g-a", "g-b"]


def test_schema_rejection_uses_existing_plain_json_fallback_with_same_guard():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, script={"g-a": [api_error(errors.ClientError, 400, "Invalid response_schema"), presentation(plan)]})
    assert fake._use_schema is False and fake.models_called() == ["g-a", "g-a"]
    assert result.source == "gemini_presentation" and "250.00 EGP" in result.response.reply


@pytest.mark.parametrize("error", [TimeoutError("PRIVATE_ERROR"), RuntimeError("PRIVATE_ERROR"), api_error(errors.ClientError, 403)])
def test_provider_failure_returns_exact_safe_plan_draft(error):
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, script={"g-a": error, "g-b": error}, gemini_max_retries=1)
    assert result.source == "deterministic" and result.response.reply == plan.draft
    assert "PRIVATE_ERROR" not in str(fake.health) + repr(result)


def test_total_timeout_is_enforced_around_injected_provider_call():
    class Slow:
        async def call(self, **kwargs):
            await asyncio.sleep(1)
            pytest.fail("Must have been cancelled")
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    fake = FakeGemini({})
    generator = GroundedGenerator(Slow(), fake.settings, GroundingLimits(max_elapsed_seconds=0.001))
    result = asyncio.run(generator.generate(plan))
    assert result.fallback_reason == "timeout" and result.response.reply == plan.draft


@pytest.mark.parametrize("text", ["I paid and nobody replied", "I will sue you", "the order is late"])
def test_owner_review_is_preserved_without_model_control(text):
    plan = EvidencePlanner().plan(text, RetrievalResult(RetrievalDecision.UNSUPPORTED))
    result, fake = generate(plan, proposal="not used")
    assert result.response.requiresReview is True and result.response.reply == plan.draft
    assert result.fallback_reason == "protected_plan" and fake.calls == []


def test_purchase_intent_is_not_order_creation():
    plan = EvidencePlanner().plan(PlanningInquiry(text="I want to buy 2 T-Shirts", option_values={"color": "Black", "size": "M"}), evidence())
    result, _ = generate(plan)
    assert result.response.intent.value == "PURCHASE_INTENT" and result.response.orderCandidate is None
    assert "order has been placed" not in result.response.reply.lower() and "500" not in result.response.reply


@pytest.mark.parametrize("resolution", [Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH])
def test_authorization_rejection_is_never_sent_to_gemini(resolution):
    from app.schemas.backend import RetrievalStatus
    failure = RetrievalStatus.AUTHORIZATION_FAILED if resolution == Resolution.AUTHORIZATION_FAILED else RetrievalStatus.SCOPE_MISMATCH
    plan = EvidencePlanner().plan("price", RetrievalResult(RetrievalDecision.PRODUCTS, failure=failure))
    result, fake = generate(plan)
    assert result.response.reply == plan.draft and fake.calls == []


@pytest.mark.parametrize("limits", [GroundingLimits(max_prompt_characters=50), GroundingLimits(max_statements=1), GroundingLimits(max_reply_characters=128)])
def test_generation_bounds_never_truncate_away_required_guidance(limits):
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result, fake = generate(plan, limits=limits)
    assert result.source == "deterministic"
    if limits.max_reply_characters >= len(plan.draft):
        assert result.response.reply == plan.draft
    else:
        assert "Current information could not be verified" in result.response.reply
    assert len(result.response.reply) <= limits.max_reply_characters


def test_duplicate_json_keys_and_excessive_proposals_are_rejected():
    with pytest.raises(ValueError):
        parse_presentation('{"opening":"none","opening":"helpful","layout":"compact","statement_ids":[]}')
    with pytest.raises(ValueError):
        parse_presentation("x" * 5000)


@pytest.mark.parametrize("kwargs", [{"max_statements": 65}, {"max_prompt_characters": True},
    {"max_reply_characters": 1}, {"max_proposal_characters": 0}, {"max_elapsed_seconds": float("nan")}])
def test_invalid_grounding_bounds_are_rejected(kwargs):
    with pytest.raises(ValueError):
        GroundingLimits(**kwargs)


def test_multiple_product_clarification_survives_final_output():
    from tests.test_evidence_planner import evidence as make_evidence
    first = make_evidence(dynamic({}, [{}]))
    other = dynamic({}, [{}])
    other["id"], other["name"] = PRODUCTS[2]["id"], "Another Product"
    other["variants"][0]["id"] = PRODUCTS[2]["variants"][0]["id"]
    other["variants"][0]["catalogItemId"] = other["id"]
    second = make_evidence(other)
    result = replace(first, candidates=first.candidates + second.candidates, evidence=first.evidence + second.evidence,
                     variant_coverage=first.variant_coverage + second.variant_coverage)
    plan = EvidencePlanner().plan("price", result)
    final, _ = generate(plan)
    assert "Which product do you mean?" in final.response.reply
    assert "Another Product" in final.response.reply and "Cotton T-Shirt" in final.response.reply


def test_provenance_mismatch_is_rejected_before_model_call():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    statements = list(plan.statements)
    position = next(i for i, s in enumerate(statements) if s.kind == "variant_observation")
    statements[position] = replace(statements[position], variant_id=UUID(PRODUCTS[2]["variants"][0]["id"]))
    broken = replace(plan, statements=tuple(statements))
    result, fake = generate(broken)
    assert result.fallback_reason == "invalid_or_bounded_plan" and fake.calls == []
    assert "250.00 EGP" not in result.response.reply


def test_raw_injected_provider_error_never_escapes_into_diagnostics():
    class Broken:
        async def call(self, **kwargs):
            raise RuntimeError("PRIVATE_CUSTOMER_SECRET")
    fake = FakeGemini({})
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    result = asyncio.run(GroundedGenerator(Broken(), fake.settings).generate(plan))
    assert result.fallback_reason == "provider_error" and result.response.reply == plan.draft
    assert "PRIVATE_CUSTOMER_SECRET" not in repr(result)


def test_caller_cancellation_is_preserved():
    class Cancelled:
        async def call(self, **kwargs):
            raise asyncio.CancelledError
    fake = FakeGemini({})
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(GroundedGenerator(Cancelled(), fake.settings).generate(plan))


def test_disabled_generator_has_no_sdk_call():
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    fake = FakeGemini({})
    result = asyncio.run(GroundedGenerator(fake, Settings(ai_provider="rules")).generate(plan))
    assert result.fallback_reason == "generation_disabled" and fake.calls == []
    assert result.response.reply == plan.draft


def test_invalid_read_only_plan_uses_generic_fallback_without_confirmed_order():
    from app.schemas import E03Intent
    plan = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
    broken = replace(plan, intent=E03Intent.CONFIRMED_ORDER, requires_review=True)
    result, fake = generate(broken)
    assert result.response.intent == E03Intent.OTHER and result.response.requiresReview
    assert fake.calls == [] and "250" not in result.response.reply


@pytest.mark.parametrize("same_business", [True, False])
def test_concurrent_presentations_do_not_share_customer_plan_or_response(same_business):
    async def run():
        class Client:
            async def call(self, **kwargs):
                await asyncio.sleep(0)
                prompt = json.loads(kwargs["user"])
                return Presentation(opening="none", layout="compact", statement_ids=[s["id"] for s in prompt["approved_statements"]]), "fake-model"
        fake = FakeGemini({})
        generator = GroundedGenerator(Client(), fake.settings)
        first = EvidencePlanner().plan(inquiry(color="Black", size="M"), evidence())
        raw = deepcopy(PRODUCTS[0])
        raw["name"], raw["businessId"] = "Second Customer Product", BUSINESS_A if same_business else BUSINESS_B
        for v in raw["variants"]:
            v["businessId"] = raw["businessId"]
        second = EvidencePlanner().plan(inquiry(color="Blue", size="M"), evidence(raw))
        a, b = await asyncio.gather(generator.generate(first), generator.generate(second))
        assert a.response.reply == first.draft and b.response.reply == second.draft
        assert "Second Customer Product" not in a.response.reply and "250.00 EGP" not in b.response.reply
        assert set(vars(generator)) == {"_client", "_settings", "_limits"}
        assert a.response is not b.response
    asyncio.run(run())


def test_changed_structured_options_are_rejected_against_retrieval_snapshot():
    """Phase 8 resolves the old gap: changing selections after retrieval must
    invalidate planning, even if the newly requested variant happens to exist.
    """
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if payload["tool"] == "get_product_details":
            product = deepcopy(PRODUCTS[0])
            product["variants"] = product["variants"][:2]  # White/M not observed
            product["variantsPagination"].update(limit=2, hasMore=True, nextOffset=2)
            data = product
        else:
            assert payload["tool"] == "get_variant_details"
            assert payload["arguments"]["variantId"] == PRODUCTS[0]["variants"][0]["id"]
            data = PRODUCTS[0]["variants"][0]
        return httpx.Response(200, json={"tool": payload["tool"], "data": data})
    adapter = BackendDataAccess(BackendClient("https://backend.test", "fixture-service", transport=httpx.MockTransport(handler)))
    scope = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_A)
    query = RetrievalQuery(text="price", variant_references=({"product_id": PRODUCT_A, "variant_id": PRODUCTS[0]["variants"][0]["id"]},))
    result = asyncio.run(RetrievalCoordinator(adapter).retrieve(query, scope=scope, context_token="fixture-context"))
    assert PlanningInquiry is RetrievalQuery and "option_values" in RetrievalQuery.model_fields
    changed = PlanningInquiry.model_validate({**query.model_dump(mode="json"), "option_values": {"color": "White", "size": "M"}})
    plan = EvidencePlanner().plan(changed, result)
    assert plan.resolution == Resolution.MISSING_DETAIL and plan.matching_variant_ids == ()
    assert "inquiry_selection_mismatch" in plan.missing_facts
    assert plan.selected_variant_id is None and plan.requires_clarification
    final, _ = generate(plan, presentation(plan, statement_ids=["White-M-verified"]))
    assert final.source == "deterministic" and "225.00 EGP" not in final.response.reply
    assert [c["tool"] for c in calls] == ["get_product_details", "get_variant_details"]
    assert all(set(c["arguments"]) <= {"productId", "variantId"} for c in calls)
