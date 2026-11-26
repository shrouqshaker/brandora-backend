"""The colour/size policy and the REAL Railway data: flat attributes, hours rows, settings flags."""
import copy
import uuid

import pytest

from app.nlu import colors_are_a_choice, product_colors, product_sizes, sizes_are_a_choice
from app.schemas import CatalogItem
from tests import railway_data as RD
from tests.helpers import VALIDATOR, add_history, rules_orchestrator, run_payload

O = rules_orchestrator()


def payload(text, catalog=None, history=(), settings=None, hours=None, knowledge=None):
    conv = [{"id": str(uuid.uuid4()), "senderType": "CUSTOMER" if w == "c" else "AI", "content": t,
             "messageType": "TEXT", "createdAt": f"2026-10-21T10:{i:02d}:00Z"} for i, (w, t) in enumerate(history)]
    return {"business": {**RD.PROFILE, "settings": settings or RD.SETTINGS, "workingHours": RD.HOURS if hours is None else hours},
            "customer": {"id": str(uuid.uuid4()), "phone": "201000000001"}, "conversation": list(reversed(conv)),
            "catalog": copy.deepcopy(catalog or RD.CATALOG), "businessKnowledge": knowledge or {},
            "message": text, "messageId": str(uuid.uuid4())}


def ask(text, **kw):
    return run_payload(O, payload(text, **kw))


def confirm(text, **kw):
    """Run `text` (builds the summary), then answer "yes" with that conversation as history."""
    first = ask(text, **kw)
    return ask("ايوه اكد", history=[("c", text), ("a", first.reply)], **{k: v for k, v in kw.items() if k != "history"})


# ---------------------------------------------------------------- flat attributes parsing
def item(name="X", **attrs):
    return CatalogItem(id=str(uuid.uuid4()), name=name, attributes=attrs)


def test_flat_attributes_are_parsed_with_flexible_keys_and_separators():
    p = item(Color="Black, Gray / بيج", Size="S, M|L", Material="Cotton")
    assert product_colors(p) == ["Black", "Gray", "بيج"] and product_sizes(p) == ["S", "M", "L"]
    assert colors_are_a_choice(p) and sizes_are_a_choice(p)
    ar = item(**{"اللون": "أسود و أبيض", "المقاس": "42"})
    assert product_colors(ar) == ["أسود", "أبيض"] and product_sizes(ar) == ["42"] and not sizes_are_a_choice(ar)
    assert product_colors(item(material="Cotton")) == [] and product_sizes(item()) == []


def test_colour_inside_the_product_name_counts_as_the_fixed_colour():
    assert product_colors(item("تيشيرت أسود")) == ["أسود"] and product_colors(item("Black Hoodie")) == ["Black"]


def test_null_attributes_and_string_prices_are_accepted():
    row = copy.deepcopy(RD.CATALOG[0]); row["attributes"] = None; row["basePrice"] = "70"
    assert CatalogItem.model_validate(row).attributes == {}


# ---------------------------------------------------------------- the real Railway catalog
def test_real_catalog_prices_stock_and_untracked_items():
    assert ask("التيشيرت بكام؟").reply == "T-Shirt بـ 299.99 جنيه."
    assert ask("how much is the hoodie?").reply == "Updated Hoodie is 450 EGP."
    assert "خلص" in ask("عايز Zero Stock Item").reply
    r = ask("هاخد 30 Blank Stock Item")   # trackInventory=false, stock null -> always available
    assert "كمية 30" in r.reply


def test_real_hours_delivery_payment_address():
    assert ask("بتفتحوا امتى؟").reply == "بنشتغل السبت من 10 الصبح لـ 10 بالليل، ومن الأحد للخميس من 9 الصبح لـ 9 بالليل، والجمعة إجازة."
    assert ask("بتوصلوا؟").reply == "التوصيل مش متاح حالياً، والاستلام من الفرع متاح."
    assert ask("ينفع ادفع كاش؟").reply == "بنقبل الدفع كاش."
    assert ask("ينفع ادفع أونلاين؟").reply == "بنقبل الدفع كاش."   # flags say cash only; never claims more
    assert ask("فين عنوانكم؟").reply == "عنواننا: Cairo, Egypt."


def test_delivery_enabled_without_prices():
    s = {**RD.SETTINGS, "deliveryEnabled": True}
    assert ask("بتوصلوا؟", settings=s).reply == "التوصيل متاح، والأسعار هتتحدد من صاحب المحل."
    s = {**RD.SETTINGS, "deliveryEnabled": False, "pickupEnabled": False}
    assert ask("بتوصلوا؟", settings=s).reply == "التوصيل مش متاح حالياً."


def test_owner_policy_text_overrides_the_default_when_present():
    k = {"policies": {"delivery": "التوصيل لكل القاهرة بـ 50 جنيه."}}
    assert ask("بتوصلوا؟", knowledge=k).reply == "التوصيل لكل القاهرة بـ 50 جنيه."


def test_hours_edge_cases():
    only_closed = [{"dayOfWeek": d, "isOpen": False} for d in ("MONDAY", "TUESDAY")]
    assert ask("بتفتحوا امتى؟", hours=only_closed).reply == "بنشتغل من الاثنين للثلاثاء إجازة."
    assert ask("what time do you open?", hours=[]).reply == "I don't have the working hours on file right now."
    odd = [{"dayOfWeek": "MONDAY", "isOpen": True, "opensAt": "09:30", "closesAt": "00:00"}]
    assert ask("بتفتحوا امتى؟", hours=odd).reply == "بنشتغل الاثنين من 9:30 الصبح لـ 12 بالليل."


# ---------------------------------------------------------------- THE colour/size policy
def test_unverifiable_colour_and_size_are_kept_not_dropped():
    r = confirm("عايز أطلب 2 تيشيرت أسود مقاس M")        # the catalog has NO colour/size for T-Shirt
    assert r.e03 == "CONFIRMED_ORDER" and r.response.requiresReview is True
    item = r.candidate.items[0]
    assert item.selectedAttributes == {"color": "أسود", "size": "M"}
    assert [x.value for x in r.candidate.reviewReasons] == ["VARIANT_UNCLEAR"]
    assert str(item.catalogItemId) == RD.TSHIRT_ID and item.quantity == 2 and item.confidence < 0.7


def test_the_customer_is_told_the_owner_will_confirm_the_options():
    r = ask("عايز أطلب 2 تيشيرت أسود مقاس M")
    assert "اللون والمقاس هيتأكد من صاحب المحل" in r.reply and r.response.requiresReview is False


def test_no_options_requested_means_no_review_and_no_questions():
    r = confirm("هاخد 2 T-Shirt")
    assert r.response.requiresReview is False and r.candidate.reviewReasons == []
    assert r.candidate.items[0].selectedAttributes == {}


def test_english_customer_words_are_preserved_as_is():
    r = confirm("I want 2 black t-shirts size M")
    assert r.candidate.items[0].selectedAttributes == {"color": "black", "size": "M"}


def test_catalog_that_defines_options_validates_them():
    cat = copy.deepcopy(RD.CATALOG)
    cat[6]["attributes"] = {"material": "Cotton", "Color": "Black, White", "Size": "S, M, L"}
    r = ask("عايز اطلب 1 T-Shirt اخضر M", catalog=cat)
    assert r.clarification and "مش متاح" in r.reply and "Black" in r.reply
    r = ask("عايز اطلب 1 T-Shirt", catalog=cat)
    assert r.clarification and "أنهي لون ومقاس" in r.reply
    r = confirm("عايز اطلب 1 T-Shirt black L", catalog=cat)
    assert r.candidate.items[0].selectedAttributes == {"color": "Black", "size": "L"} and r.candidate.reviewReasons == []


def test_fixed_single_option_never_silently_orders_another_colour():
    cat = copy.deepcopy(RD.CATALOG)
    cat[6]["attributes"] = {"Color": "Black"}
    r = ask("عايز اطلب 1 T-Shirt ابيض", catalog=cat)
    assert not r.clarification and "Black" in r.reply and r.candidate is None


def test_taking_the_last_units_flags_out_of_stock_risk():
    r = confirm("هاخد 10 T-Shirt")   # stock is exactly 10
    assert [x.value for x in r.candidate.reviewReasons] == ["OUT_OF_STOCK_RISK"] and r.response.requiresReview


def test_a_catalog_id_that_is_not_a_uuid_is_flagged_unmatched():
    cat = copy.deepcopy(RD.CATALOG); cat[6]["id"] = "sku-123"
    r = confirm("هاخد 1 T-Shirt", catalog=cat)
    assert r.candidate.items[0].catalogItemId is None
    assert "UNMATCHED_ITEM" in [x.value for x in r.candidate.reviewReasons] and r.response.requiresReview


# ---------------------------------------------------------------- the strict isActive filter
def test_inactive_items_are_removed_before_anything_else():
    cat = copy.deepcopy(RD.CATALOG)
    cat[6]["isActive"] = False   # the T-Shirt is soft-deleted
    r = ask("التيشيرت بكام؟", catalog=cat)
    assert "299.99" not in r.reply and "مش لاقي" in r.reply
    assert r.trace.dropped_inactive == 1
    r = ask("هاخد 1 T-Shirt", catalog=cat)
    assert r.candidate is None and "مش لاقي" in r.reply
