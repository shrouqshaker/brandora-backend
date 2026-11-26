"""Order assembly across messages, the confirmation step, and the E0-3 candidate (mock data, rules provider)."""
import pytest

from app.schemas import Intent
from tests.helpers import C1, C2, C5, C6, C8, C9, add_history, rules_orchestrator, run

O = rules_orchestrator()


def ask(wa, text, mutate=None):
    return run(O, wa, text, mutate)


# ---------------------------------------------------------------- before confirmation there is NO candidate (V2)
def test_complete_order_asks_for_confirmation_and_sends_no_candidate():
    r = ask(C1, "عايز أطلب 2 تيشيرت أسود مقاس L")
    assert r.e03 == "PURCHASE_INTENT" and r.candidate is None and r.plan.awaiting_confirmation
    assert r.reply == "تمام! تيشيرت قطن أسود مقاس L، كمية 2، الإجمالي 400 جنيه.\nتحب تأكد الطلب؟"
    assert r.response.requiresReview is False


def test_missing_details_are_asked_not_guessed():
    r = ask(C1, "عايز اطلب هودي كاجوال")
    assert r.clarification and r.e03 == "PURCHASE_INTENT" and r.candidate is None
    assert r.reply.startswith("تمام، هودي كاجوال. تحب أنهي لون ومقاس؟ وكام واحدة؟")
    assert "الألوان المتاحة: أسود، رمادي، كحلي." in r.reply and "المقاسات المتاحة: S، M، L، XL." in r.reply
    r = ask(C1, "عايز اطلب هودي كاجوال اسود L")
    assert r.clarification and "تحب تطلب كام واحدة؟" in r.reply and "الألوان المتاحة" not in r.reply


def test_ambiguous_product_asks_which_and_skips_soldout_and_inactive():
    r = ask(C1, "عايز اطلب تيشيرت")
    assert r.clarification and "تحب أنهي واحد؟" in r.reply
    assert "أوفر سايز" not in r.reply and "قديم" not in r.reply


def test_unknown_product_is_a_normal_reply_not_a_question():
    r = ask(C1, "عايز اطلب كرافته")
    assert not r.clarification and "مش لاقي" in r.reply and r.candidate is None


def test_invalid_option_is_rejected_and_asked_again():
    r = ask(C1, "عايز اطلب 1 هودي كاجوال احمر L")
    assert r.clarification and "مش متاح" in r.reply and "الألوان المتاحة" in r.reply


def test_soldout_and_not_enough_stock():
    r = ask(C1, "هاخد تيشيرت اوفر سايز اسود L")
    assert not r.clarification and "خلص" in r.reply and r.candidate is None
    assert "المتاح من هودي بسوستة 3 بس" in ask(C1, "هاخد 5 هودي بسوستة M").reply


def test_untracked_stock_and_quantity_limit():
    r = ask(C1, "هاخد 40 كاب اسود")
    assert "كمية 40" in r.reply and "4800 جنيه" in r.reply
    r = ask(C1, "هاخد 150 قطعة كاب اسود")
    assert r.clarification and "أقصى كمية في الطلب الواحد 100" in r.reply


def test_restaurant_needs_only_a_quantity():
    r = ask(C5, "عايز اطلب كشري")
    assert r.clarification and r.reply == "تمام، كشري طبق وسط. تحب تطلب كام واحدة؟"
    assert "180 جنيه" in ask(C5, "عايز اطلب كشري 3").reply


def test_service_booking_needs_a_time():
    r = ask(C9, "عايزة احجز مانيكير")
    assert r.clarification and "تحب الميعاد امتى؟" in r.reply
    r = ask(C9, "احجزلي مانيكير بكره الساعة 4 العصر")
    assert "الحجز" in r.reply and "بكره الساعة 4 العصر" in r.reply and "180 جنيه" in r.reply


def test_arabic_indic_digits_and_dual_forms():
    assert "كمية 2" in ask(C1, "عايز أطلب ٢ تيشيرت أسود مقاس L").reply
    assert "كمية 2" in ask(C1, "عايز اطلب تيشيرتين اسود L").reply


# ---------------------------------------------------------------- multi-turn
def test_answers_complete_the_order_in_progress():
    r = ask(C1, "الاسود L اتنين")   # c1's last message from us asked which t-shirt
    assert "تيشيرت قطن أسود مقاس L، كمية 2" in r.reply and r.candidate is None
    r = ask(C5, "اتنين")            # c5 was asked "تحب تطلب كام واحدة؟" about كشري
    assert "كشري طبق وسط، كمية 2" in r.reply and "120 جنيه" in r.reply


def test_mid_order_does_not_hijack_real_questions():
    assert ask(C1, "التيشيرت بكام؟").intent == Intent.PRICE_INQUIRY
    assert ask(C1, "بتوصلوا؟").intent == Intent.GENERAL_INFO
    assert ask(C1, "عايز تيشيرت").intent == Intent.PRODUCT_INQUIRY


def test_new_product_after_a_summary_starts_fresh():
    r = ask(C2, "عايزة اطلب جاكيت بومبر")   # c2 was just shown a grey hoodie summary
    assert r.clarification and "رمادي" not in r.reply
    assert "تحب أنهي لون ومقاس؟ وكام واحدة؟" in r.reply


def test_modifying_the_pending_order_keeps_the_rest():
    r = ask(C2, "خليها L")
    assert r.candidate is None and r.plan.awaiting_confirmation
    assert "هودي كاجوال رمادي مقاس L، كمية 1" in r.reply


# ---------------------------------------------------------------- confirmation -> CONFIRMED_ORDER + candidate (E0-3)
def test_customer_confirmation_returns_the_candidate():
    r = ask(C2, "ايوه اكدي")
    assert r.e03 == "CONFIRMED_ORDER" and r.response.requiresReview is False
    item = r.candidate.items[0]
    assert item.catalogItemId is not None and item.quantity == 1 and item.variantId is None
    assert item.selectedAttributes == {"color": "رمادي", "size": "M"} and r.candidate.reviewReasons == []
    assert str(r.candidate.sourceMessageId) == r.request["messageId"]
    assert r.reply == "تمام، هجهز طلبك للمراجعة: هودي كاجوال رمادي مقاس M، كمية 1."   # never "accepted/confirmed"


def test_the_candidate_never_carries_prices_totals_stock_or_status():
    body = ask(C2, "ايوه اكدي").body
    flat = str(body).lower()
    for forbidden in ("unitprice", "total", "stock", "status", "deliveryfee", "deposit", "price"):
        assert forbidden not in flat


def test_booking_confirmation_keeps_the_time_in_notes():
    r = ask(C8, "أيوه")
    assert r.e03 == "CONFIRMED_ORDER" and r.candidate.items[0].notes == "الجمعة الساعة 5 العصر"
    assert r.reply.startswith("تمام، هجهز حجزك للمراجعة")


def test_yes_without_a_pending_summary_is_not_an_order():
    r = ask(C1, "ايوه", add_history(("c", "السلام عليكم"), ("a", "أهلاً بيك! أقدر أساعدك إزاي؟")))
    assert r.candidate is None and r.e03 == "OTHER"


@pytest.mark.parametrize("text", ["لا خلاص الغي", "بلاش", "cancel", "لا"])
def test_declining_the_summary_creates_nothing(text):
    r = ask(C6, text)
    expected = "No problem. Let me know if you need anything else." if text == "cancel" \
        else "تمام، مفيش مشكلة. لو عايز حاجة تانية أنا موجود."
    assert r.reply == expected and r.candidate is None


def test_candidate_raw_text_is_the_customers_words_not_the_bare_yes():
    raw = ask(C2, "ايوه اكدي").candidate.items[0].rawText
    assert "هودي" in raw and "اكدي" not in raw and len(raw) <= 300
