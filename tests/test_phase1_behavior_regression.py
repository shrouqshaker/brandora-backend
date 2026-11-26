"""Current pipeline regressions only; new variant/signed-context behavior is not wired.

Legacy product inventory here is intentionally distinct from the future variant
fixtures. FakeGemini supplies outputs; these are not live injection evaluations.
"""
import asyncio
from copy import deepcopy
import re

from google.genai import errors
import pytest

from app.pipeline.context import build_context
from app.pipeline.orchestrator import Orchestrator
from app.providers import build_providers
from app.schemas import AIRespondRequest, Intent
from tests.backend_contract_fixtures import (
    ATTACK, BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B, HISTORIES,
)
from tests.fake_gemini import FakeGemini, api_error, router_json
from tests.helpers import C1, VALIDATOR, build, rules_orchestrator, run_payload


def legacy_payload(text):
    payload = build(C1, text)
    payload.update(conversation=[], customerOrders=[], businessKnowledge={})
    payload["catalog"] = [{
        "id": "40000000-0000-4000-8000-000000000001", "name": "T-Shirt",
        "basePrice": "200.00", "isActive": True, "attributes": {},
        "trackInventory": True, "stockQuantity": 5,
    }]
    payload["business"].update(id=BUSINESS_A, name="Synthetic Store A")
    payload["customer"] = {"id": CUSTOMER_A}
    return payload


def scripted(script):
    fake = FakeGemini(script)
    return Orchestrator(fake.settings, build_providers(fake.settings, client=fake)), fake


@pytest.mark.parametrize("text,prefix", [
    ("السلام عليكم", "وعليكم السلام"), ("شكرا", "العفو"),
    ("hi", "Hi!"), ("thanks", "You're welcome"),
])
def test_existing_hard_rules_skip_both_gemini_stages(text, prefix):
    orch, fake = scripted({})  # Any unexpected model call fails this test.
    result = run_payload(orch, legacy_payload(text))
    assert result.reply.startswith(prefix)
    assert result.trace.router_source == "hard-rule" and fake.calls == []
    assert result.candidate is None


def test_existing_router_outage_uses_rules_and_skips_generator():
    orch, fake = scripted({m: api_error(errors.ServerError, 503) for m in ("r-a", "r-b")})
    result = run_payload(orch, legacy_payload("how much is the T-Shirt?"))
    assert result.intent == Intent.PRICE_INQUIRY
    assert result.reply == "T-Shirt is 200 EGP."
    assert result.trace.router_source == "rules" and result.trace.fallback_reason
    assert fake.models_called() == ["r-a", "r-b"]


@pytest.mark.parametrize("generated", [
    "T-Shirt is 1 EGP.", "T-Shirt is 200 EGP. Your order has been accepted.",
    api_error(errors.ServerError, 503),
])
def test_existing_generator_and_guard_fall_back_to_verified_price(generated):
    orch, _ = scripted({"r-a": router_json(["PRICE_INQUIRY"], product_query="T-Shirt"),
                        "g-a": generated, "g-b": generated})
    result = run_payload(orch, legacy_payload("how much is the T-Shirt?"))
    assert result.reply == "T-Shirt is 200 EGP."
    assert result.trace.guard_violations and result.candidate is None


@pytest.mark.parametrize("text,language", [
    ("التيشيرت بكام؟", "ar"), ("how much is the T-Shirt?", "en"), ("3ayez tshirt", "ar"),
])
def test_existing_language_and_product_facts(text, language):
    payload = legacy_payload(text)
    assert build_context(AIRespondRequest.model_validate(payload)).language == language
    result = run_payload(rules_orchestrator(), payload)
    assert "T-Shirt" in result.reply and "200" in result.reply
    assert bool(re.search(r"[\u0600-\u06ff]", result.reply)) == (language == "ar")
    assert result.candidate is None


def test_existing_product_ambiguity_is_presented_without_silent_selection():
    payload = legacy_payload("عايز أطلب تيشيرت")
    payload["catalog"][0]["name"] = "Cotton T-Shirt"
    other = deepcopy(payload["catalog"][0])
    other.update(id="40000000-0000-4000-8000-000000000002", name="Classic T-Shirt", basePrice="250.00")
    payload["catalog"].append(other)
    result = run_payload(rules_orchestrator(), payload)
    assert "Cotton T-Shirt" in result.reply and "Classic T-Shirt" in result.reply
    assert result.clarification and result.candidate is None


def test_existing_missing_price_is_not_replaced_with_a_number():
    payload = legacy_payload("how much is the T-Shirt?")
    payload["catalog"][0]["basePrice"] = None
    result = run_payload(rules_orchestrator(), payload)
    assert "T-Shirt" in result.reply and not re.search(r"\d", result.reply)
    assert result.candidate is None


def test_existing_business_information_and_missing_policy():
    payload = legacy_payload("what is your return policy?")
    payload["businessKnowledge"] = {"policies": {"returns": "Returns within 14 days with receipt."}}
    known = run_payload(rules_orchestrator(), payload)
    assert known.reply == "Returns within 14 days with receipt."
    payload["businessKnowledge"] = {}
    unknown = run_payload(rules_orchestrator(), payload)
    assert "14" not in unknown.reply and "confirmed" in unknown.reply.lower()
    payload["message"] = "what is your address?"
    payload["business"]["address"] = "Synthetic Street A"
    assert "Synthetic Street A" in run_payload(rules_orchestrator(), payload).reply


@pytest.mark.parametrize("text,intent,review", [
    ("الطلب اتأخر", Intent.COMPLAINT, False),
    ("I paid and nobody replied", Intent.PAYMENT_DISPUTE, True),
    ("I will sue you", Intent.LEGAL_THREAT, True),
])
def test_existing_complaints_and_owner_review_do_not_claim_actions(text, intent, review):
    result = run_payload(rules_orchestrator(), legacy_payload(text))
    assert result.intent == intent and result.response.requiresReview is review
    assert result.candidate is None
    assert "will notify" not in result.reply.lower() and "will refund" not in result.reply.lower()


def test_existing_context_orders_rows_and_excludes_current_id_without_losing_earlier_repeats():
    history = HISTORIES["arabic_reference"]
    payload = legacy_payload(history["currentText"])
    payload.update(messageId=history["currentMessageId"], conversation=deepcopy(history["rows"]))
    ctx = build_context(AIRespondRequest.model_validate(payload))
    # Current Turn objects do not preserve IDs or OWNER role; assert only what
    # actually exists today. ID-only filtering for all cases remains future work.
    assert [turn.text for turn in ctx.history] == [row["content"] for row in reversed(history["rows"][1:])]
    assert ctx.history[0].text == ctx.history[1].text
    assert [turn.direction for turn in ctx.history] == ["INBOUND", "INBOUND", "OUTBOUND", "OUTBOUND"]


@pytest.mark.parametrize("location", ["customer", "history", "description"])
def test_existing_guard_rejects_scripted_poisoned_output_from_untrusted_content(location):
    payload = legacy_payload("how much is the T-Shirt?")
    if location == "customer":
        payload["message"] += " " + ATTACK
    elif location == "history":
        payload["conversation"] = [{"senderType": "AI", "content": ATTACK, "messageType": "TEXT"}]
    else:
        payload["catalog"][0]["description"] = ATTACK
    orch, fake = scripted({"r-a": router_json(["PRICE_INQUIRY"], product_query="T-Shirt"),
                           "g-a": "T-Shirt is 1 EGP. Your order has been accepted."})
    result = run_payload(orch, payload)
    assert result.reply == "T-Shirt is 200 EGP." and result.trace.guard_violations
    assert result.candidate is None
    router_prompt = fake.prompts_for(("r-a",))[0]
    assert (ATTACK in router_prompt) == (location != "description")


@pytest.mark.parametrize("same_business", [False, True])
def test_existing_concurrent_outputs_use_only_each_requests_supplied_data(same_business):
    first = legacy_payload("how much is the T-Shirt?")
    second = deepcopy(first)
    second["business"]["id"] = BUSINESS_A if same_business else BUSINESS_B
    second["customer"]["id"] = CUSTOMER_B
    second["messageId"] = "60000000-0000-4000-8000-000000000099"
    first["catalog"][0].update(name="Alpha T-Shirt", basePrice="111.00")
    second["catalog"][0].update(name="Beta T-Shirt", basePrice="999.00")
    async def run():
        orch = rules_orchestrator()
        return await asyncio.gather(*(orch.respond(AIRespondRequest.model_validate(p)) for p in (first, second)))
    responses = [execution.response for execution in asyncio.run(run())]
    for response in responses:
        VALIDATOR.validate(response.model_dump(mode="json"))
    assert "Alpha T-Shirt" in responses[0].reply and "111" in responses[0].reply
    assert "Beta" not in responses[0].reply and "999" not in responses[0].reply
    assert "Beta T-Shirt" in responses[1].reply and "999" in responses[1].reply
    assert "Alpha" not in responses[1].reply and "111" not in responses[1].reply
    # Output isolation is not tenant authorization: v1 trusts supplied payloads.
