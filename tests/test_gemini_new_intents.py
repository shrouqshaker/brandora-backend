"""Router + Generator + Guard with the new intents / fields, through the real pipeline (scripted Gemini)."""
import json

import pytest
from google import genai
from google.genai import _transformers as tr

from app.pipeline.guard import check_reply
from app.schemas import Intent, Plan, RouterResult
from tests.fake_gemini import router_json
from tests.helpers import C1, C9, add_history, build
from tests.test_catalog_policy import payload as railway_payload
from tests.test_pipeline_gemini import go, pipeline

CANCEL_ASK = "عايز تلغي طلب رقم 1002 (هودي كاجوال)؟ اكتب (ايوه) لتأكيد الإلغاء."


def history_cancel():
    return add_history(("c", "عايز ألغي الأوردر"), ("a", CANCEL_ASK))


# ---------------------------------------------------------------- the Gemini-facing schema
def test_router_schema_has_every_intent_once_no_defaults_and_the_new_fields():
    d = tr.t_schema(genai.Client(api_key="k")._api_client, RouterResult).model_dump(exclude_none=True, mode="json")
    enum = d["properties"]["intents"]["items"]["enum"]
    assert sorted(enum) == sorted(i.value for i in Intent) and len(enum) == len(set(enum)) == 16
    assert json.dumps(d).count('"default"') == 0 and d["required"] == ["intents", "confidence"]
    for field in ("max_price", "faq_id", "requires_review", "confirmation", "order_reference"):
        assert field in d["properties"], field


def test_router_accepts_the_legacy_follow_up_value():
    r = RouterResult.model_validate_json(router_json(["FOLLOW_UP"]))
    assert r.intents == [Intent.ORDER_STATUS]


# ---------------------------------------------------------------- dynamic FAQ through the Router
def test_router_picks_a_faq_by_number_when_the_words_differ():
    orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=2), "g-a": "x"})
    response, trace, plan = go(orch, build(C9, "عايزة اعرف تفاصيل الباكدجات بتاعتكم"))
    assert plan.detailed_intent == Intent.GENERAL_INFO and response.reply.startswith("باقة العروسة بتبدأ من 6000 جنيه")
    assert "6000" not in fake.prompts_for(("r-a",))[0]   # the answer text never went to the model


def test_a_faq_number_that_does_not_exist_is_ignored_and_nothing_is_invented():
    orch, _ = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=99), "g-a": "x"})
    response, _, _ = go(orch, build(C1, "الفرع فيه باركينج؟"))
    assert response.reply.startswith("معلش معنديش معلومة مؤكدة")


def test_code_overrides_a_router_that_called_a_faq_question_a_price_question():
    orch, _ = pipeline({"r-a": router_json(["PRICE_INQUIRY"]), "g-a": "x"})
    _, _, plan = go(orch, build(C9, "الباقة بكام؟"))
    assert plan.detailed_intent == Intent.GENERAL_INFO and plan.reply == "باقة العروسة بتبدأ من 6000 جنيه."
    orch, _ = pipeline({"r-a": router_json(["UNKNOWN"], confidence=0.9), "g-a": "x"})
    assert go(orch, build(C9, "الباقه بكام"))[2].detailed_intent == Intent.GENERAL_INFO


def test_a_real_catalog_price_question_is_not_taken_by_the_faq():
    orch, _ = pipeline({"r-a": router_json(["PRICE_INQUIRY"], product_query="كيراتين"), "g-a": "كيراتين بـ 2500 جنيه."})
    assert go(orch, build(C9, "كيراتين بكام؟"))[2].detailed_intent == Intent.PRICE_INQUIRY


# ---------------------------------------------------------------- budget through the Router
def test_router_max_price_filters_the_products():
    orch, _ = pipeline({"r-a": router_json(["PRODUCT_INQUIRY"], product_query="تيشيرت", max_price=190), "g-a": "x"})
    _, _, plan = go(orch, build(__import__("tests.helpers", fromlist=["C4"]).C4, "عايز تيشيرت رخيص"))
    assert "180 جنيه" in plan.reply and "200 جنيه" not in plan.reply


@pytest.mark.parametrize("bad", [-5, 0, 1e12, float("inf")])
def test_a_nonsense_budget_from_the_router_is_dropped(bad):
    raw = '{"intents":["PRODUCT_INQUIRY"],"confidence":0.9,"product_query":"تيشيرت","max_price":%s}' % ("Infinity" if bad == float("inf") else bad)
    orch, _ = pipeline({"r-a": raw, "g-a": "x"})
    _, _, plan = go(orch, build(__import__("tests.helpers", fromlist=["C4"]).C4, "عايز تيشيرت"))
    assert "250 جنيه" in plan.reply   # no ceiling applied: the polo (250) is listed again


# ---------------------------------------------------------------- owner review
@pytest.mark.parametrize("intent", ["PAYMENT_DISPUTE", "LEGAL_THREAT", "CUSTOM_REQUEST"])
def test_escalation_intents_always_set_requires_review_and_never_call_the_generator(intent):
    orch, fake = pipeline({"r-a": router_json([intent], confidence=0.9), "g-a": "x"})   # note: no requires_review from the model
    response, _, plan = go(orch, railway_payload("رسالة"))
    assert response.requiresReview is True and response.intent.value == "OTHER" and response.orderCandidate is None
    assert fake.models_called() == ["r-a"] and plan.owner_review


def test_requires_review_from_the_model_is_honoured_only_for_complaints():
    orch, _ = pipeline({"r-a": router_json(["COMPLAINT"], requires_review=True), "g-a": "x"})
    assert go(orch, railway_payload("الطلب اتأخر"))[0].requiresReview is True
    orch, _ = pipeline({"r-a": router_json(["PRICE_INQUIRY"], product_query="T-Shirt", requires_review=True), "g-a": "T-Shirt بـ 299.99 جنيه."})
    assert go(orch, railway_payload("التيشيرت بكام؟"))[0].requiresReview is False


def test_careful_mode_skips_the_generator_for_an_upset_customer():
    orch, fake = pipeline({"r-a": router_json(["PRICE_INQUIRY"], product_query="T-Shirt"), "g-a": "T-Shirt بـ 299.99 جنيه. تحب تطلبه؟"})
    response, trace, plan = go(orch, railway_payload("التيشيرت بكام؟", history=[("c", "هشتكي عليكم"), ("a", "آسف")]))
    assert "g-a" not in fake.models_called() and plan.grounded is False and "تحب تطلبه" not in response.reply


# ---------------------------------------------------------------- cancel / modify confirmation decided by the Router
def test_router_yes_after_a_cancel_question_confirms_the_cancellation():
    orch, _ = pipeline({"r-a": router_json(["ORDER_CANCEL"], confirmation="YES", confidence=0.95), "g-a": "x"})
    response, _, plan = go(orch, build(C1, "حاضر يا باشا", history_cancel()))
    assert plan.detailed_intent == Intent.ORDER_CANCEL and response.requiresReview is True
    assert response.reply == "تمام. إلغاء طلب رقم 1002 محتاج صاحب المحل يأكده بنفسه."


def test_router_no_after_a_cancel_question_leaves_the_order_alone():
    orch, _ = pipeline({"r-a": router_json(["ORDER_CANCEL"], confirmation="NO", confidence=0.95), "g-a": "x"})
    response, _, _ = go(orch, build(C1, "مش دلوقتي يا باشا", history_cancel()))
    assert response.reply == "تمام، الطلب زي ما هو." and response.requiresReview is False


def test_an_unsure_router_yes_does_not_cancel_anything():
    orch, _ = pipeline({"r-a": router_json(["ORDER_CANCEL"], confirmation="YES", confidence=0.6), "g-a": "x"})
    response, _, _ = go(orch, build(C1, "حاضر يا باشا", history_cancel()))
    assert response.requiresReview is False and "محتاج صاحب المحل يأكده" not in response.reply


def test_router_orders_status_with_a_reference():
    orch, _ = pipeline({"r-a": router_json(["ORDER_STATUS"], order_reference="1002"), "g-a": "x"})
    response, _, _ = go(orch, build(C1, "طلب رقم 1002 وصل فين"))
    assert response.reply.startswith("طلبك رقم 1002 (هودي كاجوال) حالته: قيد التنفيذ")


# ---------------------------------------------------------------- the Guard learned the new promises
@pytest.mark.parametrize("bad", ["تم إلغاء طلبك", "تم الغاء طلبك", "طلبك اتلغى", "تم تعديل طلبك", "هنرجعلك فلوسك", "هيتم استرداد المبلغ",
                                 "هبلغ صاحب المحل", "Your order has been cancelled", "we will refund you", "I will notify the owner"])
def test_guard_rejects_cancellation_refund_and_forwarding_claims(bad):
    plan = Plan(Intent.ORDER_CANCEL, "تمام.")
    lang = "en" if bad.isascii() else "ar"
    assert any("forbidden" in p for p in check_reply(f"تمام. {bad}" if lang == "ar" else f"Okay. {bad}", plan, lang)), bad


def test_guard_allows_the_fixed_owner_wording_and_a_status_report():
    for draft in ("تمام. إلغاء طلب رقم 1002 محتاج صاحب المحل يأكده بنفسه.", "طلبك رقم 1001 (x) حالته: اتلغى.",
                  "آسف على اللي حصل. ممكن تبعتلي رقم الطلب وطريقة الدفع؟\nده بيساعد صاحب المحل يراجع الموضوع."):
        assert check_reply(draft, Plan(Intent.UNKNOWN, draft), "ar") == []
