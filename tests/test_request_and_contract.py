"""The request shapes the backend really sends + the E0-3 response contract (Schema 1.0), incl. the doc's 3 examples."""
import copy
import uuid

import jsonschema
import pytest
from pydantic import ValidationError

import mock_data
from app.pipeline.context import build_context
from app.schemas import AIRespondRequest, AiResponse, ReviewReason
from tests import railway_data as RD
from tests.helpers import C1, C2, VALIDATOR, rules_orchestrator, run, run_payload
from tests.test_catalog_policy import payload as railway_payload


# ================================================================= request
def test_the_real_railway_payload_is_accepted_as_is():
    req = AIRespondRequest.model_validate(railway_payload("بتفتحوا امتى؟"))
    assert len(req.business.workingHours) == 7 and req.business.workingHours[4].isOpen is False
    assert req.catalog[6].attributes == {"material": "Cotton"} and str(req.catalog[6].basePrice) == "299.99"
    assert req.business.settings.deliveryEnabled is False


def test_message_can_be_a_string_or_an_object_and_message_id_is_required():
    base = railway_payload("hi")
    as_obj = {**base, "message": {"id": base["messageId"], "text": "  hi  "}}
    del as_obj["messageId"]
    req = AIRespondRequest.model_validate(as_obj)
    assert req.text == "hi" and str(req.messageId) == base["messageId"]
    for bad in ({"messageId": None}, {"message": "   "}, {"message": "x" * 2001}, {"messageId": "not-a-uuid"}):
        broken = {**base, **bad}
        if bad.get("messageId") is None and "messageId" in bad:
            del broken["messageId"]
        with pytest.raises(ValidationError):
            AIRespondRequest.model_validate(broken)


def test_unknown_fields_are_ignored_not_rejected():
    p = railway_payload("hi"); p["foo"] = 1; p["business"]["bar"] = 2; p["catalog"][0]["createdAt"] = "x"
    AIRespondRequest.model_validate(p)


def test_conversation_is_sorted_and_the_current_message_is_not_repeated():
    p = railway_payload("ايوه اكد")
    mid = p["messageId"]
    p["conversation"] = [  # newest first, as the messages API returns them, and the current message already stored
        {"id": mid, "senderType": "CUSTOMER", "content": "ايوه اكد", "createdAt": "2026-10-21T10:03:00Z"},
        {"id": str(uuid.uuid4()), "senderType": "AI", "content": "تحب تأكد الطلب؟", "createdAt": "2026-10-21T10:02:00Z"},
        {"id": str(uuid.uuid4()), "senderType": "OWNER", "content": "اهلا", "createdAt": "2026-10-21T10:01:00Z"},
        {"id": str(uuid.uuid4()), "senderType": "CUSTOMER", "content": "عايز تيشيرت", "createdAt": "2026-10-21T10:00:00Z"},
        {"id": str(uuid.uuid4()), "senderType": "CUSTOMER", "content": "", "createdAt": "2026-10-21T10:04:00Z"},
        {"id": str(uuid.uuid4()), "senderType": "CUSTOMER", "content": "[image]", "messageType": "IMAGE", "createdAt": "2026-10-21T10:05:00Z"},
    ]
    ctx = build_context(AIRespondRequest.model_validate(p))
    assert [(t.direction, t.text) for t in ctx.history] == [
        ("INBOUND", "عايز تيشيرت"), ("OUTBOUND", "اهلا"), ("OUTBOUND", "تحب تأكد الطلب؟")]
    assert ctx.awaiting_confirm and ctx.mid_order


def test_inactive_and_nameless_catalog_rows_are_dropped_in_the_context():
    p = railway_payload("hi")
    p["catalog"][0]["isActive"] = False
    p["catalog"][1]["name"] = "   "
    ctx = build_context(AIRespondRequest.model_validate(p))
    assert len(ctx.products) == 5 and ctx.dropped_inactive == 2
    assert "Test" not in [x.name for x in ctx.products]


# ================================================================= E0-3 examples from the contract document
SRC = "3f2b8c1e-5a4d-4e0b-9d57-1c2a7e9b1a10"
ITEM = "a7c1d2e4-1b3f-4c5d-8e6f-0a9b8c7d6e5f"
EX1 = {"intent": "CONFIRMED_ORDER", "reply": "تمام، هجهز طلبك للمراجعة.", "requiresReview": False,
       "orderCandidate": {"sourceMessageId": SRC, "confidence": 0.95, "reviewReasons": [], "notes": None, "items": [
           {"catalogItemId": ITEM, "variantId": None, "rawText": "تيشيرت أسود M", "quantity": 2,
            "selectedAttributes": {"size": "M", "color": "أسود"}, "notes": None, "confidence": 0.95}]}}
EX2 = {"intent": "CONFIRMED_ORDER", "reply": "تمام، هجهز طلبك للمراجعة.", "requiresReview": True,
       "orderCandidate": {"sourceMessageId": SRC, "confidence": 0.55, "reviewReasons": ["UNMATCHED_ITEM"], "notes": None,
                          "items": [{"catalogItemId": None, "variantId": None, "rawText": "الهودي اللي في الصورة",
                                     "quantity": 1, "confidence": 0.4}]}}
EX3 = {"intent": "CONFIRMED_ORDER", "reply": "تم قبول طلبك.", "requiresReview": False,
       "orderCandidate": {"sourceMessageId": SRC, "confidence": 0.9, "reviewReasons": [], "items": [
           {"catalogItemId": ITEM, "rawText": "تيشيرت أسود M", "quantity": 2, "unitPrice": 1, "confidence": 0.9}]}}


def test_doc_example_1_success_is_valid():
    VALIDATOR.validate(EX1)
    assert AiResponse.model_validate(EX1).orderCandidate.items[0].quantity == 2


def test_doc_example_2_success_with_review_is_valid():
    VALIDATOR.validate(EX2)
    assert AiResponse.model_validate(EX2).orderCandidate.items[0].catalogItemId is None


def test_doc_example_3_forbidden_unit_price_is_rejected_by_schema_and_model():
    with pytest.raises(jsonschema.ValidationError):
        VALIDATOR.validate(EX3)
    with pytest.raises(ValidationError):
        AiResponse.model_validate(EX3)


@pytest.mark.parametrize("forbidden", ["unitPrice", "total", "stock", "status", "deliveryFee", "deposit"])
def test_every_forbidden_field_is_rejected_on_item_and_candidate_and_top_level(forbidden):
    for where in ("item", "candidate", "top"):
        body = copy.deepcopy(EX1)
        target = {"item": body["orderCandidate"]["items"][0], "candidate": body["orderCandidate"], "top": body}[where]
        target[forbidden] = 1
        with pytest.raises(ValidationError):
            AiResponse.model_validate(body)
        with pytest.raises(jsonschema.ValidationError):
            VALIDATOR.validate(body)


def mutated(**changes):
    body = copy.deepcopy(EX1)
    for path, value in changes.items():
        node = body
        keys = path.split("__")
        for k in keys[:-1]:
            node = node[int(k)] if k.isdigit() else node[k]
        node[keys[-1]] = value
    return body


@pytest.mark.parametrize("changes", [
    {"intent": "INQUIRY"},                                    # V2: candidate only with CONFIRMED_ORDER
    {"orderCandidate": None},                                 # V2: CONFIRMED_ORDER needs a candidate
    {"reply": ""},
    {"orderCandidate__items": []},                            # V3
    {"orderCandidate__items__0__quantity": 0},                # V6
    {"orderCandidate__items__0__quantity": 101},
    {"orderCandidate__items__0__quantity": 1.5},
    {"orderCandidate__confidence": 1.2},                      # V7
    {"orderCandidate__items__0__confidence": -0.1},
    {"orderCandidate__items__0__catalogItemId": "sku-1"},
    {"orderCandidate__sourceMessageId": "nope"},
    {"orderCandidate__reviewReasons": ["MADE_UP"]},
    {"orderCandidate__reviewReasons": ["VARIANT_UNCLEAR"]},   # V9: reasons present but requiresReview false
    {"intent": "PURCHASE_INTENT"},
])
def test_invalid_responses_are_rejected(changes):
    body = mutated(**changes)
    with pytest.raises(ValidationError):
        AiResponse.model_validate(body)


def test_the_ai_never_sets_low_item_confidence():
    """The threshold (0.7) lives in the Backend config, so the AI must not emit LOW_ITEM_CONFIDENCE itself."""
    from tests import railway_data  # noqa: F401
    r = run(rules_orchestrator(), C2, "ايوه اكدي")
    assert ReviewReason.LOW_ITEM_CONFIDENCE not in r.candidate.reviewReasons


def test_a_whole_run_of_responses_always_has_exactly_the_four_top_level_keys():
    o = rules_orchestrator()
    for wa, text in [(C1, "عايز تيشيرت"), (C1, "hi"), (C2, "ايوه اكدي"), (C1, "طلبي وصل فين")]:
        assert set(run(o, wa, text).body) == {"intent", "reply", "requiresReview", "orderCandidate"}
