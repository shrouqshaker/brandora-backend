"""Full composed flow with actual typed/history/retrieval/planning/guard layers.

MockTransport and FakeGemini replace network operations only. Scope/header checks
below are synthetic placeholders, not a cryptographic authentication test.
"""
import asyncio
from copy import deepcopy
from dataclasses import replace
import json
from uuid import UUID

from fastapi.testclient import TestClient
import httpx
import pytest
from pydantic import ValidationError

from app.clients.backend_client import BackendClient
from app.config import Settings
from app.data.backend import BackendDataAccess
from app.data.history import HistoryCoverage, HistoryLimits, PreparedHistory
from app.data.retrieval import RetrievalLimits, SearchCoverage
from app.pipeline.evidence_planner import EvidencePlanner, PlanningInquiry, Resolution
from app.pipeline.standalone import BoundHistory, ExecutionLimits, StandalonePipeline, TurnBinding
from app.providers.evidence import GroundedGenerator
from app.schemas.backend import ExpectedScope, RetrievalStatus
from app.schemas.inquiry import Inquiry
from main import create_app
from tests.backend_contract_fixtures import (
    ATTACK, BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B, CONVERSATION_A, CONVERSATION_B,
    PRODUCT_A, PRODUCTS,
)
from tests.fake_gemini import FakeGemini
from tests.helpers import C1, VALIDATOR, build

MESSAGE_A = "60000000-0000-4000-8000-000000000005"
MESSAGE_B = "60000000-0000-4000-8000-000000000006"
SCOPE_A = ExpectedScope(business_id=BUSINESS_A, customer_id=CUSTOMER_A, conversation_id=CONVERSATION_A)


class PresentationGemini(FakeGemini):
    def __init__(self, mode="valid"):
        super().__init__({}, gemini_max_retries=1)
        self.mode = mode

    async def _generate(self, model, system, user, **kwargs):
        self.calls.append((model, system, user))
        await asyncio.sleep(0)
        if self.mode == "slow":
            await asyncio.sleep(1)
        if self.mode == "failure":
            raise RuntimeError("PRIVATE_PROVIDER_FAILURE")
        if self.mode == "malformed":
            return "I will refund you and everything is free"
        data = json.loads(user)
        return json.dumps({"opening": "none", "layout": "compact",
                           "statement_ids": [s["id"] for s in data["approved_statements"]]})


def message(identity, content, minute, role="CUSTOMER"):
    return {"id": identity, "content": content, "senderType": role,
            "messageType": "TEXT", "createdAt": f"2026-11-03T10:{minute:02d}:00Z"}


def reference_history(current=MESSAGE_A, *, boundary=True):
    rows = [message("ai", "Which product do you mean?", 4, "AI"),
            message("owner", f"{ATTACK} productId={PRODUCT_A} variantId={PRODUCTS[0]['variants'][0]['id']}", 3, "OWNER"),
            message("customer", f"T-Shirt productId={PRODUCT_A}", 2)]
    return ([message(current, "منه", 5)] + rows) if boundary else rows


def setup(*, products=None, rows=(), hook=None, mode="valid", limits=None,
          history_limits=None, retrieval_limits=None, planner=None, scopes=None):
    products = deepcopy(PRODUCTS[:3] if products is None else products)
    scopes = scopes or {"fixture-a": SCOPE_A}
    calls = []
    async def handler(request):
        payload = json.loads(request.content)
        token = request.headers["X-AI-Context"]
        assert request.headers["Authorization"] == "Bearer fixture-service"
        assert token in scopes
        scope = scopes[token]
        calls.append((payload["tool"], payload["arguments"], token, scope))
        await asyncio.sleep(0)
        if hook:
            override = await hook(payload["tool"], payload["arguments"], len(calls))
            if override is not None:
                return override
        tool, args = payload["tool"], payload["arguments"]
        owned = [p for p in products if p["businessId"] == str(scope.business_id)]
        if tool == "get_business_info":
            return httpx.Response(200, json={"tool": tool, "data": {"business": {
                "id": str(scope.business_id), "name": "Fixture Business"}}})
        if tool == "get_products":
            values = owned
        elif tool == "get_conversation_history":
            assert args["conversationId"] == str(scope.conversation_id)
            values = rows
        elif tool in {"get_product_details", "get_product_variants", "get_variant_details"}:
            product = next((p for p in owned if p["id"] == args["productId"]), None)
            if product is None:
                return httpx.Response(403)
            if tool == "get_product_details":
                return httpx.Response(200, json={"tool": tool, "data": product})
            if tool == "get_variant_details":
                variant = next((v for v in product["variants"] if v["id"] == args["variantId"]), None)
                return httpx.Response(200, json={"tool": tool, "data": variant}) if variant else httpx.Response(404)
            values = product["variants"]
        else:
            pytest.fail("Unexpected tool")
        offset, limit = args["offset"], args["limit"]
        more = offset + limit < len(values)
        return httpx.Response(200, json={"tool": tool, "data": {"items": values[offset:offset + limit],
            "pagination": {"limit": limit, "offset": offset, "totalCount": len(values),
                           "hasMore": more, "nextOffset": offset + limit if more else None}}})
    data = BackendDataAccess(BackendClient("https://backend.test", "fixture-service", transport=httpx.MockTransport(handler)))
    fake = PresentationGemini(mode)
    generator = GroundedGenerator(fake, fake.settings)
    pipeline = StandalonePipeline(data, generator, limits=limits, history_limits=history_limits,
                                  retrieval_limits=retrieval_limits, planner=planner)
    return pipeline, calls, fake


def execute(pipeline, text="price", *, scope=SCOPE_A, message_id=MESSAGE_A, token="fixture-a", **kwargs):
    query = kwargs.pop("inquiry", Inquiry(text=text, product_ids=(PRODUCT_A,), option_values={"color": "Black", "size": "M"}))
    result = asyncio.run(pipeline.execute(query, scope=scope, message_id=message_id, context_token=token, **kwargs))
    VALIDATOR.validate(result.response.model_dump(mode="json"))
    assert result.response.orderCandidate is None and result.response.intent.value != "CONFIRMED_ORDER"
    assert result.inquiry is result.retrieval.inquiry
    assert "fixture-a" not in repr(result) + repr(result.diagnostics)
    return result


@pytest.mark.parametrize("text,expected", [("hi", "Hi!"), ("thanks", "You're welcome"),
    ("السلام عليكم", "وعليكم السلام"), ("شكرا", "العفو")])
def test_hard_rules_need_no_history_backend_or_gemini(text, expected):
    pipeline, calls, fake = setup()
    result = execute(pipeline, inquiry=Inquiry(text=text))
    assert expected in result.response.reply and calls == fake.calls == []
    assert result.diagnostics.backend_calls == 0


def test_structured_selection_is_one_immutable_request_through_all_stages():
    seen = []
    class Planner(EvidencePlanner):
        def plan(self, inquiry, result, history=None):
            seen.append((inquiry, result.inquiry))
            with pytest.raises(TypeError):
                inquiry.option_values["size"] = "L"
            return super().plan(inquiry, result, history)
    pipeline, calls, fake = setup(planner=Planner())
    options = {"color": "Black", "size": "M"}
    query = Inquiry(text="price", product_ids=(PRODUCT_A,), option_values=options)
    options["size"] = "L"
    result = execute(pipeline, inquiry=query)
    assert seen[0][0] is seen[0][1] is result.inquiry
    assert result.inquiry.option_values == {"color": "Black", "size": "M"}
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]
    assert calls[-1][1]["variantId"] == PRODUCTS[0]["variants"][0]["id"]
    assert all(c[2] == "fixture-a" and c[3] == SCOPE_A for c in calls)
    assert "250.00 EGP" in result.response.reply and "recorded stock: 5" in result.response.reply
    assert len(fake.calls) == 1
    assert all(set(c[1]) <= {"productId", "variantId"} for c in calls)  # no new Backend args


def test_later_planner_cannot_introduce_a_new_option_selection():
    class ChangingPlanner(EvidencePlanner):
        def plan(self, inquiry, result, history=None):
            changed = Inquiry.model_validate({**inquiry.model_dump(mode="json"), "option_values": {"color": "White", "size": "M"}})
            return super().plan(changed, result, history)
    pipeline, calls, _ = setup(planner=ChangingPlanner())
    result = execute(pipeline)
    assert result.plan.resolution == Resolution.MISSING_DETAIL
    assert "inquiry_selection_mismatch" in result.plan.missing_facts
    assert result.plan.products == result.plan.variants == ()
    assert "225.00 EGP" not in result.response.reply and len(calls) == 2


@pytest.mark.parametrize("text,options,price,stock", [
    ("price", {"color": "Black", "size": "L"}, "200.00 EGP", "no recorded stock remains"),
    ("التيشيرت بكام؟", {"لون": "أسود", "مقاس": "M"}, "250.00 EGP", "5"),
    ("3ayez tshirt", {"color": "Blue", "size": "M"}, "0.00 EGP", "1"),
    ("price", {"color": "White", "size": "M"}, "225.00 EGP", "availability unconfirmed"),
])
def test_prices_inventory_and_multilingual_options_end_to_end(text, options, price, stock):
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text=text, product_ids=(PRODUCT_A,), option_values=options))
    assert price in result.response.reply and stock in result.response.reply
    assert result.diagnostics.backend_calls == len(calls) == 2


@pytest.mark.parametrize("keys,options", [( ("لون", "مقاس"), {"لون": "Black", "مقاس": "M"}),
    (("Material", "Configuration"), {"Material": "Cotton", "Configuration": "Pro"})])
def test_dynamic_declared_keys_match_same_actual_variant_in_retrieval_and_plan(keys, options):
    product = deepcopy(PRODUCTS[0])
    product["options"] = {key: [value] for key, value in options.items()}
    product["variants"] = product["variants"][:1]
    product["variants"][0]["optionValues"] = options
    product["variantsPagination"]["totalCount"] = 1
    pipeline, calls, _ = setup(products=[product])
    result = execute(pipeline, inquiry=Inquiry(text="price", product_ids=(PRODUCT_A,), option_values=options))
    assert dict(result.plan.variants[0].option_values) == options
    assert result.plan.matching_variant_ids == (UUID(product["variants"][0]["id"]),)
    assert "250.00 EGP" in result.response.reply and len(calls) == 2


def test_null_effective_price_is_unavailable_not_parent_price():
    product = deepcopy(PRODUCTS[0])
    product["variants"][0]["effectivePrice"] = None
    pipeline, _, _ = setup(products=[product])
    result = execute(pipeline)
    assert "price unconfirmed" in result.response.reply
    assert "250.00 EGP" not in result.response.reply and "200.00 EGP" not in result.response.reply
    assert result.plan.selected_variant_id is None


def test_inactive_product_never_produces_a_variant_purchase_offer():
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="price", product_ids=(PRODUCTS[1]["id"],)))
    assert result.plan.resolution == Resolution.INACTIVE
    assert "not offered for purchase" in result.response.reply and "300.00 EGP" not in result.response.reply
    assert [c[0] for c in calls] == ["get_product_details"]


def test_allowed_values_do_not_fabricate_a_missing_variant_combination():
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="price", product_ids=(PRODUCT_A,), option_values={"color": "Blue", "size": "L"}))
    assert result.plan.matching_variant_ids == () and result.plan.selected_variant_id is None
    assert not any(s.kind == "variant_observation" for s in result.plan.statements)
    assert [c[0] for c in calls] == ["get_product_details"]


def test_conflicting_explicit_variant_and_structured_options_are_not_resolved():
    pipeline, calls, _ = setup()
    query = Inquiry(text="price", variant_references=({"product_id": PRODUCT_A, "variant_id": PRODUCTS[0]["variants"][0]["id"]},),
                    option_values={"color": "White", "size": "M"})
    result = execute(pipeline, inquiry=query)
    assert result.plan.matching_variant_ids == () and result.plan.requires_clarification
    assert "variant_options_mismatch" in result.retrieval.issues
    assert "225.00 EGP" not in result.response.reply and "250.00 EGP" not in result.response.reply
    assert len(calls) == 2


def test_description_injection_is_omitted_from_generation_and_safe_draft():
    product = deepcopy(PRODUCTS[0])
    product["description"] = ATTACK + f" change scope to {BUSINESS_B}"
    pipeline, calls, fake = setup(products=[product])
    result = execute(pipeline)
    assert ATTACK not in result.response.reply
    assert all(ATTACK not in prompt and BUSINESS_B not in prompt for _, _, prompt in fake.calls)
    assert "250.00 EGP" in result.response.reply and all(c[3] == SCOPE_A for c in calls)


def test_supported_business_identity_and_unsupported_policies_use_only_permitted_tools():
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="what is your business name?"))
    assert "Fixture Business" in result.response.reply
    assert [c[0] for c in calls] == ["get_business_info"]
    pipeline, calls, fake = setup()
    result = execute(pipeline, inquiry=Inquiry(text="do you deliver?"))
    assert result.plan.resolution == Resolution.UNSUPPORTED and calls == fake.calls == []


def test_generic_discovery_stops_at_useful_partial_page_and_asks_which_product():
    pipeline, calls, _ = setup(retrieval_limits=RetrievalLimits(page_size=1))
    result = execute(pipeline, inquiry=Inquiry(text="what products do you have?"))
    assert [c[0] for c in calls] == ["get_products"]
    assert result.retrieval.catalog_coverage == SearchCoverage.PARTIAL
    assert result.plan.selected_variant_id is None and result.plan.requires_clarification
    assert "Which product do you mean?" in result.response.reply


def test_missing_product_in_partial_scan_is_not_catalog_absence():
    pipeline, calls, _ = setup(products=[PRODUCTS[2], PRODUCTS[0]], retrieval_limits=RetrievalLimits(page_size=1, max_product_pages=1))
    result = execute(pipeline, inquiry=Inquiry(text="do you have a T-Shirt?"))
    assert result.plan.resolution == Resolution.NO_MATCH_PARTIAL
    assert result.plan.products == () and len(calls) == 1
    assert "no other" not in result.response.reply.lower()


def test_multiple_actual_variants_require_clarification_and_do_not_mix_prices():
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="price", product_ids=(PRODUCT_A,), option_values={"color": "Black"}))
    assert result.plan.resolution == Resolution.MULTIPLE_VARIANTS
    assert result.plan.selected_variant_id is None and "size" in result.response.reply.lower()
    assert "250.00 EGP; recorded stock: 5" in result.response.reply
    assert "200.00 EGP; recorded stock: 0" in result.response.reply
    assert len(calls) == 1


def test_multiple_product_candidates_do_not_fan_out_into_detail_calls():
    other = deepcopy(PRODUCTS[0])
    other["id"], other["name"], other["variants"] = PRODUCTS[2]["id"], "Classic T-Shirt", []
    other["variantsPagination"]["totalCount"] = 0
    pipeline, calls, _ = setup(products=[PRODUCTS[0], other])
    result = execute(pipeline, inquiry=Inquiry(text="how much is the T-Shirt?"))
    assert result.plan.resolution == Resolution.PRODUCT_AMBIGUITY and len(calls) == 1
    assert "Which product do you mean?" in result.response.reply


def test_followup_binds_history_turn_revalidates_references_and_ignores_injected_claims():
    pipeline, calls, fake = setup(rows=reference_history())
    result = execute(pipeline, inquiry=Inquiry(text="منه"))
    assert [c[0] for c in calls] == ["get_conversation_history", "get_product_details", "get_variant_details"]
    assert result.history.binding == result.binding
    assert result.binding.message_id == UUID(MESSAGE_A) and result.history.prepared.chronology_uncertain
    assert result.plan.requires_clarification and result.plan.selected_variant_id is None
    assert ATTACK not in result.response.reply
    assert all(ATTACK not in prompt for _, _, prompt in fake.calls)
    assert result.diagnostics.backend_calls == len(calls) == 3


@pytest.mark.parametrize("rows", [[], reference_history(boundary=False)])
def test_missing_history_or_current_boundary_never_silently_resolves_references(rows):
    pipeline, calls, _ = setup(rows=rows)
    result = execute(pipeline, inquiry=Inquiry(text="yes"))
    assert [c[0] for c in calls] == ["get_conversation_history"]
    assert "current_boundary_unknown" in result.history.prepared.issues
    assert result.plan.products == result.plan.variants == () and result.plan.requires_clarification


def test_history_can_be_explicitly_skipped_without_synthesizing_context():
    pipeline, calls, _ = setup(rows=reference_history())
    result = execute(pipeline, inquiry=Inquiry(text="yes"), prepare_history=False)
    assert calls == [] and result.history is None and result.plan.requires_clarification


@pytest.mark.parametrize("field", ["business", "customer", "conversation", "message"])
def test_supplied_history_must_match_every_scope_and_turn_identifier(field):
    scope = SCOPE_A.model_dump()
    message_id = MESSAGE_A
    if field == "business":
        scope["business_id"] = BUSINESS_B
    elif field == "customer":
        scope["customer_id"] = CUSTOMER_B
    elif field == "conversation":
        scope["conversation_id"] = CONVERSATION_B
    else:
        message_id = MESSAGE_B
    supplied = BoundHistory(TurnBinding(scope=ExpectedScope(**scope), message_id=message_id), PreparedHistory(HistoryCoverage.COMPLETE))
    pipeline, calls, fake = setup()
    result = execute(pipeline, history=supplied)
    assert result.plan.resolution == Resolution.SCOPE_MISMATCH and result.history is None
    assert result.retrieval.evidence == () and result.plan.products == () and calls == fake.calls == []


def test_matching_supplied_history_does_not_trigger_another_history_fetch():
    from app.data.history import ReferenceHint
    prior = PreparedHistory(HistoryCoverage.PARTIAL, references=(
        ReferenceHint("older", "CUSTOMER", ("T-Shirt",), None, None, None, UUID(PRODUCT_A), None),))
    supplied = BoundHistory(TurnBinding(scope=SCOPE_A, message_id=MESSAGE_A), prior)
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="منه"), history=supplied)
    assert result.history.binding == result.binding and result.plan.requires_clarification
    assert [c[0] for c in calls] == ["get_product_details"]
    assert result.history.prepared is not prior


def test_supplied_history_cannot_bypass_configured_context_limits():
    from app.data.history import HistoryTurn
    prior = PreparedHistory(HistoryCoverage.PARTIAL, messages=(
        HistoryTurn("older", "CUSTOMER", "x" * 20, "TEXT", None, None),))
    supplied = BoundHistory(TurnBinding(scope=SCOPE_A, message_id=MESSAGE_A), prior)
    pipeline, calls, fake = setup(history_limits=HistoryLimits(max_characters=10))
    result = execute(pipeline, history=supplied)
    assert result.history is None and result.plan.resolution == Resolution.INVALID
    assert "supplied_history_limit" in result.diagnostics.issues
    assert calls == fake.calls == []


@pytest.mark.parametrize("method,status", [("get_conversation_history", 403), ("get_product_details", 401)])
def test_authorization_rejection_never_sends_protected_data_to_generation(method, status):
    async def hook(tool, args, count):
        return httpx.Response(status, text="PRIVATE_BACKEND_SECRET") if tool == method else None
    pipeline, calls, fake = setup(rows=reference_history(), hook=hook)
    result = execute(pipeline, inquiry=Inquiry(text="منه"))
    assert result.history is None and result.retrieval.evidence == ()
    assert result.plan.products == result.plan.variants == () and fake.calls == []
    assert result.plan.resolution == Resolution.AUTHORIZATION_FAILED
    assert "PRIVATE_BACKEND_SECRET" not in repr(result.diagnostics)


def test_scope_failure_after_history_success_discards_history_and_evidence():
    async def hook(tool, args, count):
        if tool == "get_product_details":
            product = deepcopy(PRODUCTS[0])
            product["businessId"] = BUSINESS_B
            return httpx.Response(200, json={"tool": tool, "data": product})
    pipeline, calls, fake = setup(rows=reference_history(), hook=hook)
    result = execute(pipeline, inquiry=Inquiry(text="منه"))
    assert len(calls) == 2 and fake.calls == []
    assert result.history is None and result.retrieval.evidence == ()
    assert result.plan.resolution == Resolution.SCOPE_MISMATCH and "Cotton T-Shirt" not in result.response.reply


@pytest.mark.parametrize("mode", ["timeout", "invalid", "missing"])
def test_backend_failures_preserve_no_fabricated_details(mode):
    async def hook(tool, args, count):
        if tool == "get_product_details":
            if mode == "timeout":
                raise httpx.ReadTimeout("PRIVATE_BACKEND_SECRET")
            return httpx.Response(404) if mode == "missing" else httpx.Response(200, json={"tool": tool, "data": {}})
    pipeline, calls, fake = setup(hook=hook)
    result = execute(pipeline)
    assert len(calls) == 1 and fake.calls == []
    assert result.plan.products == result.plan.variants == ()
    assert result.plan.resolution in {Resolution.UNAVAILABLE, Resolution.INVALID}
    assert "250.00 EGP" not in result.response.reply


@pytest.mark.parametrize("mode", ["failure", "malformed"])
def test_provider_failure_falls_back_to_the_existing_guarded_plan(mode):
    pipeline, calls, fake = setup(mode=mode)
    result = execute(pipeline)
    assert result.response.reply == result.plan.draft
    assert result.generation.source == "deterministic" and len(calls) == 2
    assert len(fake.calls) == 2 and "PRIVATE_PROVIDER_FAILURE" not in repr(result.diagnostics)


def test_purchase_intent_is_not_an_order_or_reservation():
    pipeline, calls, _ = setup()
    query = Inquiry(text="I want to buy 2 T-Shirts", product_ids=(PRODUCT_A,), option_values={"color": "Black", "size": "M"})
    result = execute(pipeline, inquiry=query)
    assert result.response.intent.value == "PURCHASE_INTENT" and result.response.orderCandidate is None
    assert "500" not in result.response.reply and "order has been placed" not in result.response.reply.lower()
    assert all(c[0] in {"get_product_details", "get_variant_details"} for c in calls)
    assert result.order_extension.enabled is False
    provisional = result.order_extension.purchase_intent
    assert provisional.requested_quantity == 2
    assert any(r.product_id == UUID(PRODUCT_A) and r.variant_id == UUID(PRODUCTS[0]["variants"][0]["id"])
               for r in provisional.references)
    assert all(r.revalidated is False for r in provisional.references)
    assert set(result.response.model_dump()) == {"intent", "reply", "requiresReview", "orderCandidate"}


def test_order_extension_has_no_enable_switch_or_execution_handler():
    from dataclasses import FrozenInstanceError
    from app.pipeline.extensions import DisabledOrderExtension
    extension = DisabledOrderExtension()
    assert extension.enabled is False and extension.purchase_intent is None
    with pytest.raises(TypeError):
        DisabledOrderExtension(enabled=True)
    with pytest.raises(FrozenInstanceError):
        extension.enabled = True
    assert not hasattr(extension, "execute") and not hasattr(extension, "create_order")


def test_read_only_inquiry_does_not_create_purchase_handoff():
    pipeline, calls, _ = setup()
    result = execute(pipeline)
    assert result.order_extension.enabled is False and result.order_extension.purchase_intent is None
    assert [c[0] for c in calls] == ["get_product_details", "get_variant_details"]


def test_unauthorized_purchase_has_no_order_handoff_or_protected_references():
    async def hook(tool, args, count):
        return httpx.Response(403)
    pipeline, calls, fake = setup(hook=hook)
    result = execute(pipeline, inquiry=Inquiry(text="I want to buy 2 T-Shirts", product_ids=(PRODUCT_A,),
                                              option_values={"color": "Black", "size": "M"}))
    assert result.order_extension.enabled is False and result.order_extension.purchase_intent is None
    assert result.plan.products == result.plan.variants == () and fake.calls == []
    assert result.response.orderCandidate is None and len(calls) == 1


def test_disabled_purchase_handoff_does_not_mutate_current_read_validation_or_render_promises():
    pipeline, calls, _ = setup()
    result = execute(pipeline, inquiry=Inquiry(text="I want to buy 2 T-Shirts", product_ids=(PRODUCT_A,),
                                              option_values={"color": "Black", "size": "M"}))
    assert any(reference.revalidated for reference in result.plan.references)
    assert all(not reference.revalidated for reference in result.order_extension.purchase_intent.references)
    assert not hasattr(result.order_extension.purchase_intent, "unitPrice")
    assert not hasattr(result.order_extension.purchase_intent, "stockQuantity")
    assert not hasattr(result.order_extension.purchase_intent, "status")
    assert "No reservation is made" in result.response.reply and len(calls) == 2


@pytest.mark.parametrize("text", ["I paid and nobody replied", "I will sue you", "the order is late"])
def test_owner_review_is_preserved_in_composed_flow(text):
    pipeline, calls, fake = setup()
    result = execute(pipeline, inquiry=Inquiry(text=text))
    assert result.response.requiresReview and result.plan.requires_review
    assert calls == fake.calls == [] and "will refund" not in result.response.reply.lower()


def test_assembly_rejects_a_generator_that_downgrades_review_or_changes_intent():
    from app.providers.evidence import GroundedGeneration
    from app.schemas.response import AiResponse, E03Intent
    class BrokenGenerator(GroundedGenerator):
        async def generate(self, plan):
            return GroundedGeneration(AiResponse(intent=E03Intent.PURCHASE_INTENT, reply="incorrect result",
                                                 requiresReview=False, orderCandidate=None), "fake")
    existing, calls, fake = setup()
    pipeline = StandalonePipeline(existing._data, BrokenGenerator(fake, fake.settings))
    result = execute(pipeline, inquiry=Inquiry(text="I will sue you"))
    assert result.response.intent == result.plan.intent == E03Intent.OTHER
    assert result.response.requiresReview and result.response.reply == result.plan.draft
    assert result.generation.fallback_reason == "invalid_generation_result" and calls == fake.calls == []


def test_total_backend_call_budget_includes_history_and_retrieval():
    rows = reference_history()
    # Put a real reference inside the two-page history budget; retrieval must
    # then attempt revalidation and encounter the cumulative operation cap.
    pipeline, calls, fake = setup(rows=rows[:1] + rows[2:], limits=ExecutionLimits(max_backend_calls=2),
                                  history_limits=HistoryLimits(page_size=1, max_pages=2))
    result = execute(pipeline, inquiry=Inquiry(text="منه"))
    assert len(calls) == result.diagnostics.backend_calls == 2
    assert [c[0] for c in calls] == ["get_conversation_history", "get_conversation_history"]
    assert "total_call_limit" in result.diagnostics.issues and result.plan.products == () and fake.calls == []


@pytest.mark.parametrize("stage", ["history", "retrieval", "generation"])
def test_total_execution_timeout_cancels_current_stage_with_safe_fallback(stage):
    async def hook(tool, args, count):
        if (stage == "history" and tool == "get_conversation_history") or (stage == "retrieval" and tool == "get_products"):
            await asyncio.sleep(1)
        return None
    pipeline, calls, fake = setup(rows=reference_history(), hook=hook,
                                  mode="slow" if stage == "generation" else "valid",
                                  limits=ExecutionLimits(max_elapsed_seconds=0.1))
    query = Inquiry(text="منه") if stage == "history" else Inquiry(text="what products do you have?") if stage == "retrieval" else Inquiry(text="price", product_ids=(PRODUCT_A,), option_values={"color": "Black", "size": "M"})
    result = execute(pipeline, inquiry=query)
    assert result.diagnostics.stopped_stage == stage and "total_time_limit" in result.diagnostics.issues
    assert result.generation.fallback_reason == "total_execution_timeout"
    if stage != "generation":
        assert result.history is None and result.plan.products == () and fake.calls == []
    else:
        assert result.response.reply == result.plan.draft and "250.00 EGP" in result.response.reply


def test_caller_cancellation_propagates_without_late_generation():
    async def run():
        entered = asyncio.Event()
        async def hook(tool, args, count):
            entered.set()
            await asyncio.sleep(1)
        pipeline, _, fake = setup(hook=hook)
        task = asyncio.create_task(pipeline.execute(Inquiry(text="what products do you have?"),
            scope=SCOPE_A, message_id=MESSAGE_A, context_token="fixture-a"))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert fake.calls == []
    asyncio.run(run())


@pytest.mark.parametrize("same_business", [True, False])
def test_concurrent_customers_keep_scope_selections_history_and_diagnostics_local(same_business):
    async def run():
        other_scope = ExpectedScope(business_id=BUSINESS_A if same_business else BUSINESS_B,
                                    customer_id=CUSTOMER_B, conversation_id=CONVERSATION_B)
        products = deepcopy(PRODUCTS[:3])
        other_id = PRODUCT_A
        if not same_business:
            other = deepcopy(PRODUCTS[0])
            other["id"], other["businessId"], other["name"] = PRODUCTS[3]["id"], BUSINESS_B, "Private Business B T-Shirt"
            for i, variant in enumerate(other["variants"]):
                variant.update(id=f"50000000-0000-4000-8000-{101+i:012d}", businessId=BUSINESS_B,
                               catalogItemId=other["id"], unitPrice="700.00", effectivePrice="700.00")
            products.append(other)
            other_id = other["id"]
        pipeline, calls, fake = setup(products=products, scopes={"fixture-a": SCOPE_A, "fixture-b": other_scope})
        a = Inquiry(text="price", product_ids=(PRODUCT_A,), option_values={"color": "Black", "size": "M"})
        b = Inquiry(text="price", product_ids=(other_id,), option_values={"color": "Blue", "size": "M"})
        first, second = await asyncio.gather(
            pipeline.execute(a, scope=SCOPE_A, message_id=MESSAGE_A, context_token="fixture-a"),
            pipeline.execute(b, scope=other_scope, message_id=MESSAGE_B, context_token="fixture-b"))
        assert first.binding.scope == SCOPE_A and second.binding.scope == other_scope
        assert first.binding.message_id != second.binding.message_id
        assert first.diagnostics.backend_calls == second.diagnostics.backend_calls == 2
        assert len(calls) == 4 and len(fake.calls) == 2
        assert "250.00 EGP" in first.response.reply and "250.00 EGP" not in second.response.reply
        assert ("0.00 EGP" if same_business else "700.00 EGP") in second.response.reply
        assert "Private Business B" not in first.response.reply
        assert first.inquiry is not second.inquiry and first.plan is not second.plan
        assert set(vars(pipeline)) == {"_data", "_generator", "_planner", "_limits", "_history_limits", "_retrieval_limits", "_clock"}
        assert "fixture-a" not in repr(first) and "fixture-b" not in repr(second)
    asyncio.run(run())


def test_live_v1_factory_and_routes_remain_unchanged_and_no_v2_is_mounted():
    client = TestClient(create_app(Settings(ai_provider="rules", app_env="local", legacy_api_enabled=True)))
    response = client.post("/v1/ai/respond", json=build(C1, "hi"))
    assert response.status_code == 200 and response.json()["reply"].startswith("Hi!")
    VALIDATOR.validate(response.json())
    assert client.post("/v2/ai/respond", json={}).status_code == 404
    assert type(client.app.state.orchestrator).__name__ == "Orchestrator"


@pytest.mark.parametrize("kwargs", [{"max_backend_calls": 0}, {"max_backend_calls": True},
    {"max_elapsed_seconds": 0}, {"max_elapsed_seconds": float("nan")}])
def test_invalid_total_budgets_rejected(kwargs):
    with pytest.raises(ValueError):
        ExecutionLimits(**kwargs)


def test_incomplete_scope_is_rejected_before_any_backend_call():
    pipeline, calls, fake = setup()
    with pytest.raises(ValidationError):
        execute(pipeline, scope=ExpectedScope(business_id=BUSINESS_A))
    assert calls == fake.calls == []


@pytest.mark.parametrize("options", [{"": "Black"}, {"color": " "}, {"size": 3}])
def test_shared_inquiry_rejects_invalid_structured_values(options):
    with pytest.raises(ValidationError):
        Inquiry(text="price", option_values=options)


def test_shared_inquiry_aliases_and_json_snapshot_preserve_compatibility():
    from app.data.retrieval import RetrievalQuery
    assert PlanningInquiry is RetrievalQuery is Inquiry
    source = Inquiry(text="price", product_ids=(PRODUCT_A,), option_values={"size": "M"})
    copied = Inquiry.model_validate(source.model_dump(mode="json"))
    assert source == copied and copied.option_values == {"size": "M"}
    with pytest.raises(TypeError):
        copied.option_values["size"] = "L"


@pytest.mark.parametrize("token", ["", "bad\r\nheader", None])
def test_invalid_context_token_is_rejected_without_network_or_raw_token_in_error(token):
    pipeline, calls, _ = setup()
    with pytest.raises(ValueError, match="Invalid per-call context token"):
        execute(pipeline, token=token)
    assert calls == []
