"""The customer-service intents (HELP, ORDER_STATUS, ORDER_MODIFY, ORDER_CANCEL, RETURNS_POLICY, PAYMENT_DISPUTE,
LEGAL_THREAT, CUSTOM_REQUEST), the owner-review flag, budgets (max_price), dynamic business FAQs and careful mode."""
import copy
import uuid

import pytest

from app.schemas import Intent
from tests.helpers import C1, C2, C3, C4, C5, C6, C8, C9, add_history, rules_orchestrator, run

O = rules_orchestrator()


def ask(wa, text, mutate=None):
    return run(O, wa, text, mutate)


def order(number, status, name="هودي كاجوال", created="2026-10-05T18:30:00Z"):
    return {"orderNumber": number, "status": status, "createdAt": created, "items": [{"name": name, "quantity": 1}]}


def with_orders(*orders):
    def mutate(payload):
        payload["customerOrders"] = list(orders)
    return mutate


# ---------------------------------------------------------------- every new intent, its E0-3 mapping and the review flag
@pytest.mark.parametrize("wa,text,intent,e03,review", [
    (C1, "إزاي أطلب؟", Intent.HELP, "INQUIRY", False),
    (C1, "إزاي أستخدم البوت؟", Intent.HELP, "INQUIRY", False),
    (C1, "how do I order?", Intent.HELP, "INQUIRY", False),
    (C1, "طلبي وصل فين؟", Intent.ORDER_STATUS, "INQUIRY", False),
    (C1, "إمتى هيوصل؟", Intent.ORDER_STATUS, "INQUIRY", False),
    (C1, "where is my order", Intent.ORDER_STATUS, "INQUIRY", False),
    (C1, "عايز أغير العنوان", Intent.ORDER_MODIFY, "OTHER", False),
    (C1, "ممكن أعدل الطلب؟", Intent.ORDER_MODIFY, "OTHER", False),
    (C1, "عايز ألغي الأوردر", Intent.ORDER_CANCEL, "OTHER", False),
    (C1, "I want to cancel my order", Intent.ORDER_CANCEL, "OTHER", False),
    (C1, "إزاي أرجع المنتج؟", Intent.RETURNS_POLICY, "INQUIRY", False),
    (C1, "الاستبدال خلال كام يوم؟", Intent.RETURNS_POLICY, "INQUIRY", False),
    (C1, "أنا دفعت ومحدش رد", Intent.PAYMENT_DISPUTE, "OTHER", True),
    (C1, "دفعت والطلب لسه مجاش", Intent.PAYMENT_DISPUTE, "OTHER", True),
    (C1, "I paid and nobody replied", Intent.PAYMENT_DISPUTE, "OTHER", True),
    (C1, "هشتكي عليكم", Intent.LEGAL_THREAT, "OTHER", True),
    (C1, "I will sue you", Intent.LEGAL_THREAT, "OTHER", True),
    (C1, "عايز تصميم خاص", Intent.CUSTOM_REQUEST, "OTHER", True),
    (C1, "عايز أتفق على حاجة مخصوصة", Intent.CUSTOM_REQUEST, "OTHER", True),
    (C1, "الطلب اتأخر", Intent.COMPLAINT, "OTHER", False),
])
def test_new_intents_mapping_and_owner_review(wa, text, intent, e03, review):
    r = ask(wa, text)
    assert r.intent == intent and r.e03 == e03 and r.response.requiresReview is review
    assert r.candidate is None   # none of these creates an order


def test_follow_up_is_the_same_as_order_status():
    assert Intent.FOLLOW_UP is Intent.ORDER_STATUS and Intent("FOLLOW_UP") is Intent.ORDER_STATUS


def test_help_and_returns_and_status_replies():
    assert ask(C1, "إزاي أطلب؟").reply.startswith("تقدر تكتبلي اسم المنتج اللي عايزه")
    assert ask(C1, "how do I order?").reply.startswith("Just type the product you want")
    assert "14 يوم" in ask(C1, "إزاي أرجع المنتج؟").reply
    assert ask(C5, "إزاي أرجع المنتج؟").reply.startswith("معلش معنديش معلومة مؤكدة")   # no policy -> never invented
    assert ask(C1, "طلبي وصل فين؟").reply == "طلبك رقم 1002 (هودي كاجوال) حالته: قيد التنفيذ."


def test_eta_question_never_invents_a_delivery_time():
    assert ask(C1, "إمتى هيوصل؟").reply == "طلبك رقم 1002 (هودي كاجوال) حالته: قيد التنفيذ. ومعنديش موعد وصول مؤكد."
    assert "اتسلم" in ask(C3, "إمتى هيوصل؟").reply and "موعد وصول" not in ask(C3, "إمتى هيوصل؟").reply


def test_escalation_replies_are_calm_and_promise_nothing():
    for text, start in [("أنا دفعت ومحدش رد", "آسف على اللي حصل"), ("هشتكي عليكم", "آسف إنك متضايق"),
                        ("عايز تصميم خاص", "الطلبات المخصوصة")]:
        r = ask(C1, text)
        assert r.reply.startswith(start) and "هراجع" not in r.reply and "هتواصل" not in r.reply
    assert ask(C1, "I will sue you").reply.startswith("Sorry you're this upset")


def test_escalation_beats_every_other_signal():
    assert ask(C1, "الطلب اتأخر وهشتكي عليكم").intent == Intent.LEGAL_THREAT
    assert ask(C1, "عايز ألغي الطلب لأني دفعت ومحدش رد").intent == Intent.PAYMENT_DISPUTE
    assert Intent.COMPLAINT in ask(C1, "الطلب اتأخر وهشتكي عليكم").secondary


def test_no_false_alarms():
    assert ask(C1, "إزاي ارجع المنتج؟").intent == Intent.RETURNS_POLICY            # not HELP
    assert ask(C1, "إزاي أطلب تيشيرت؟").intent == Intent.HELP                      # not CREATE_ORDER
    assert ask(C1, "دفعت 200 جنيه وعايز اطلب تيشيرت").intent != Intent.PAYMENT_DISPUTE
    assert ask(C1, "ينفع ادفع كاش؟").intent == Intent.GENERAL_INFO
    assert ask(C1, "customer service hours?").intent != Intent.CUSTOM_REQUEST


# ---------------------------------------------------------------- cancel / modify an existing order (two steps, owner decides)
def test_cancel_asks_for_confirmation_first_and_names_the_order():
    r = ask(C1, "عايز ألغي الأوردر")
    assert r.reply == "عايز تلغي طلب رقم 1002 (هودي كاجوال)؟ اكتب (ايوه) لتأكيد الإلغاء."
    assert r.response.requiresReview is False and r.candidate is None


@pytest.mark.parametrize("answer", ["ايوه", "ايوه الغي", "اه الغي", "yes cancel", "لا خلاص الغي"])
def test_confirming_the_cancellation_flags_the_owner(answer):
    h = add_history(("c", "عايز ألغي الأوردر"), ("a", "عايز تلغي طلب رقم 1002 (هودي كاجوال)؟ اكتب (ايوه) لتأكيد الإلغاء."))
    r = ask(C1, answer, h)
    expected = "Okay. Cancelling order #1002 needs to be confirmed by the store owner." if answer == "yes cancel" \
        else "تمام. إلغاء طلب رقم 1002 محتاج صاحب المحل يأكده بنفسه."
    assert r.intent == Intent.ORDER_CANCEL and r.reply == expected
    assert r.response.requiresReview is True and r.candidate is None and r.e03 == "OTHER"
    assert "اتلغى" not in r.reply and "cancelled" not in r.reply.lower()   # never claims it was cancelled


@pytest.mark.parametrize("answer", ["لا", "لا متلغيش", "سيبه", "don't cancel", "keep it", "ايوه متلغيش"])
def test_declining_the_cancellation_leaves_the_order(answer):
    h = add_history(("c", "عايز ألغي الأوردر"), ("a", "عايز تلغي طلب رقم 1002 (هودي كاجوال)؟ اكتب (ايوه) لتأكيد الإلغاء."))
    r = ask(C1, answer, h)
    assert r.response.requiresReview is False and r.candidate is None
    assert r.reply in ("تمام، الطلب زي ما هو.", "Okay, the order stays as it is.")


def test_modify_flow():
    r = ask(C1, "عايز أغير العنوان")
    assert r.reply == "عايز تعدّل طلب رقم 1002 (هودي كاجوال)؟ اكتب (ايوه) لتأكيد التعديل." and not r.response.requiresReview
    h = add_history(("c", "عايز أغير العنوان"), ("a", r.reply))
    done = ask(C1, "ايوه عدل", h)
    assert done.intent == Intent.ORDER_MODIFY and done.response.requiresReview is True
    assert done.reply.startswith("تمام. تعديل طلب رقم 1002 محتاج صاحب المحل يأكده بنفسه")
    assert ask(C1, "لا سيبه", h).reply == "تمام، الطلب زي ما هو."
    assert ask(C1, "مش عايز اعدل", h).reply == "تمام، الطلب زي ما هو."


def test_which_order_when_several_are_active():
    two = with_orders(order(1002, "IN_PROGRESS"), order(1007, "PENDING_APPROVAL", "تيشيرت قطن أسود", "2026-10-06T10:00:00Z"))
    r = ask(C1, "عايز ألغي الأوردر", two)
    assert r.reply.startswith("قصدك أنهي طلب؟") and "#1002: هودي كاجوال" in r.reply and "#1007" in r.reply and r.clarification
    assert ask(C1, "عايز ألغي طلب رقم 1007", two).reply.startswith("عايز تلغي طلب رقم 1007 (تيشيرت قطن أسود)")


def test_cancel_edge_cases():
    assert ask(C4, "عايز ألغي الأوردر").reply.startswith("مفيش طلب شغال على رقمك")           # nothing in progress
    assert ask(C1, "عايز ألغي طلب رقم 9999").reply.startswith("مش لاقي طلب رقم 9999")
    done = ask(C3, "عايز ألغي طلب رقم 1001")                                                # already delivered
    assert "اتسلم" in done.reply and done.response.requiresReview is False
    no_orders = ask(C1, "عايز ألغي الأوردر", lambda p: p.pop("customerOrders"))              # backend sent no order data
    assert no_orders.reply == "عايز تلغي الطلب؟ اكتب (ايوه) لتأكيد الإلغاء."


def test_english_cancel_flow():
    r = ask(C1, "I want to cancel my order")
    assert r.reply == "Do you want to cancel order #1002 (هودي كاجوال)? Reply yes to confirm the cancellation."
    done = ask(C1, "yes", add_history(("c", "I want to cancel my order"), ("a", r.reply)))
    assert done.response.requiresReview and done.reply.startswith("Okay. Cancelling order #1002")


def test_while_an_order_summary_is_open_modifying_means_that_order():
    r = ask(C2, "ممكن أغير المقاس لـ L؟")   # c2 was just shown a hoodie summary
    assert r.intent == Intent.CREATE_ORDER and "مقاس L" in r.reply and not r.response.requiresReview


# ---------------------------------------------------------------- budgets (max_price)
def test_budget_filters_the_matching_products():
    r = ask(C4, "عندكم تيشيرت تحت 200 جنيه؟")
    assert "180 جنيه" in r.reply and "200 جنيه" in r.reply and "250" not in r.reply and "220" not in r.reply
    r = ask(C4, "عندكم تيشيرت ارخص من 190؟")
    assert "180" in r.reply and "200" not in r.reply


def test_budget_with_nothing_cheap_enough_names_the_cheapest():
    assert ask(C4, "عندكم تيشيرت تحت 150 جنيه؟").reply == \
        "مفيش تيشيرت تحت 150 جنيه حاليًا. أرخص واحد: تيشيرت قطن أبيض بـ 180 جنيه."


def test_budget_only_question_lists_everything_under_the_ceiling():
    r = ask(C4, "عندكم حاجة تحت 130 جنيه؟")
    assert r.reply == "المتاح تحت 130 جنيه:\nكاب قطن بـ 120 جنيه\nتحب تختار أنهي واحد؟"
    assert ask(C4, "عندكم حاجة تحت 100 جنيه؟").reply == "مفيش منتجات تحت 100 جنيه حاليًا."
    assert ask(C4, "ميزانيتي ميتين").intent == Intent.PRODUCT_INQUIRY


def test_budget_in_english_and_with_orders():
    en = ask(C4, "do you have t-shirts under 190?").reply
    assert en.startswith("We have تيشيرت قطن أبيض for 180 EGP.") and "200" not in en and "250" not in en
    r = ask(C4, "عايز اطلب 2 تيشيرت تحت 190 مقاس L")
    assert "تيشيرت قطن أبيض مقاس L" in r.reply and "360 جنيه" in r.reply   # only the white one fits the budget


def test_inactive_and_unpriced_items_never_satisfy_a_budget():
    def unpriced(p):
        p["catalog"][0]["basePrice"] = None   # the black t-shirt has no price on file
    r = ask(C4, "عندكم تيشيرت تحت 500", unpriced)
    assert "تيشيرت قطن أسود" not in r.reply and "قديم" not in r.reply and "99" not in r.reply


# ---------------------------------------------------------------- dynamic business FAQ
@pytest.mark.parametrize("wa,text,answer", [
    (C9, "الباقة بكام؟", "باقة العروسة بتبدأ من 6000 جنيه."),
    (C9, "الباقه بكام", "باقة العروسة بتبدأ من 6000 جنيه."),
    (C5, "الموز بيوصل امتى؟", "الموز بيوصل طازج كل يوم الصبح."),
    (C1, "اللمبة الحمرا معلقة", "اللمبة الحمرا معناها إن البطارية ضعيفة. اشحنها وهتطفي."),
    (C1, "اللمبه الحمرا معلقه في السماعه", "اللمبة الحمرا معناها إن البطارية ضعيفة. اشحنها وهتطفي."),
])
def test_dynamic_faq_answers_come_straight_from_the_owners_text(wa, text, answer):
    r = ask(wa, text)
    assert r.intent == Intent.GENERAL_INFO and r.reply == answer and r.e03 == "INQUIRY"


def test_a_business_question_with_no_faq_says_there_is_no_confirmed_info():
    r = ask(C1, "الفرع بتاعكم فيه باركينج؟")
    assert r.intent == Intent.GENERAL_INFO or r.reply.startswith("معلش")
    assert r.reply.startswith("معلش معنديش معلومة مؤكدة") or "مش لاقي" in r.reply


def test_faq_does_not_steal_catalog_questions():
    assert ask(C9, "كيراتين بكام؟").intent == Intent.PRICE_INQUIRY
    assert ask(C5, "عايز اطلب كشري").intent == Intent.CREATE_ORDER
    assert ask(C5, "عندكم عصير؟").intent == Intent.PRODUCT_INQUIRY


# ---------------------------------------------------------------- careful mode for an upset customer
def test_after_a_threat_the_customer_gets_fixed_templates_and_no_sales_push():
    h = add_history(("c", "هشتكي عليكم"), ("a", "آسف إنك متضايق للدرجة دي. ممكن تكتبلي المشكلة بالتفصيل ورقم الطلب لو موجود؟"))
    r = ask(C1, "عندكم هودي بسوستة؟", h)
    assert r.plan.grounded is False and "تحب تطلبه" not in r.reply and "باقي 3 بس" in r.reply
    calm = ask(C1, "عندكم هودي بسوستة؟")
    assert calm.plan.grounded is True and "تحب تطلبه" in calm.reply


def test_a_complaint_after_a_dispute_keeps_escalating():
    h = add_history(("c", "أنا دفعت ومحدش رد"), ("a", "آسف على اللي حصل."))
    assert ask(C1, "الطلب اتأخر", h).response.requiresReview is True
    assert ask(C1, "الطلب اتأخر").response.requiresReview is False


def test_careful_mode_expires_after_a_few_messages():
    h = add_history(("c", "هشتكي عليكم"), ("a", "x"), ("c", "عندكم هودي"), ("a", "y"), ("c", "بكام"), ("a", "z"),
                    ("c", "ماشي"), ("a", "w"))
    assert ask(C1, "عندكم هودي بسوستة؟", h).plan.grounded is True
