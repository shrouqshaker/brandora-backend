"""Customer-facing policy through canonical signed HTTP and shared renderer."""
import asyncio
from dataclasses import replace

import pytest

from app.offline_demo import OfflineHarness
from app.chat.__main__ import build
from app.chat.application import ChatSession
from app.chat.natural import clauses_for, NaturalReply, Sentence, validate_composition
from app.chat.understanding import needs_conversation_history
from app.chat.synthetic import identifier
from app.providers.structured import StructuredOutputError
from app.schemas.response import ReviewReason


PREFIX=("عندكم تيشيرت أسود؟","طب مقاس L بكام؟","طب عايزة 10 قطع من مقاس L")
CORRECTION="طب خلاص، خليهم 3 قطع من الأبيض مقاس L بدل الأسود"


def send(h,message):
    result=h.send(h.body(message))
    assert result.status_code==200,result.text
    response=result.json()
    assert set(response)=={"intent","reply","requiresReview","orderCandidate"}
    assert response["orderCandidate"] is None
    return response


def customer_copy(reply):
    for forbidden in ("المتسجل","المخزون المسجل","الداتابيز","orderCandidate","تم إخطار","تم إبلاغ",
                      "تم حجز","تم إنشاء طلب","recorded stock"):
        assert forbidden not in reply


@pytest.mark.parametrize("failure",[None,503,"timeout","json","semantic","guard"])
def test_exact_four_turn_http_correction_with_model_and_fallback(failure):
    h=OfflineHarness()
    h.model_failure=failure
    for message in PREFIX:
        response=send(h,message)
        customer_copy(response["reply"])
    assert response["requiresReview"] and response["intent"]=="PURCHASE_INTENT"
    assert "4" not in response["reply"] and response["reply"].count("10")==1
    assert "المسؤول" in response["reply"] and "مش متاحة بالكامل" in response["reply"]
    start=len(h.calls)
    response=send(h,CORRECTION)
    assert response["intent"]=="PURCHASE_INTENT" and not response["requiresReview"]
    assert all(value in response["reply"] for value in ("الأبيض","L","285","3")),response
    assert "275" not in response["reply"] and "الأسود" not in response["reply"]
    assert response["reply"].count("3")==1
    assert {"get_conversation_history","get_product_details","get_variant_details"} <= {c["tool"] for c in h.calls[start:]}
    customer_copy(response["reply"])


@pytest.mark.parametrize("message,fragments",[
    ("خليهم 3 من الأبيض بدل الأسود",("الأبيض","L","285","3")),
    ("غيرت رأيي، عايزة الأبيض مقاس M",("الأبيض","M","225")),
    # Blue/L is inactive in this catalog: retain the product/size but never
    # quote its withdrawn 205 price or substitute Blue/M.
    ("طب خليها الأزرق بدل الأسود",("اختيار نشط",)),
    ("طب خليهم 2",("الأسود","L","2")),
    ("طب خليهم 12",("الأسود","L","12","المسؤول")),
])
def test_contextual_changes_refresh_data(message,fragments):
    h=OfflineHarness()
    for text in PREFIX:
        send(h,text)
    assert needs_conversation_history(message)
    start=len(h.calls)
    response=send(h,message)
    assert all(v in response["reply"] for v in fragments),response
    assert "get_conversation_history" in [c["tool"] for c in h.calls[start:]]
    customer_copy(response["reply"])
    if "الأزرق" in message:
        assert "205" not in response["reply"] and "0 جنيه" not in response["reply"]


def test_unrelated_named_product_does_not_inherit_or_read_history():
    h=OfflineHarness()
    for text in PREFIX:
        send(h,text)
    start=len(h.calls)
    response=send(h,"بدل الأسود عايزة الكاب")
    assert "get_conversation_history" not in [c["tool"] for c in h.calls[start:]]
    assert "get_products" in [c["tool"] for c in h.calls[start:]]
    assert "275" not in response["reply"] and "285" not in response["reply"]
    assert not response["requiresReview"]


@pytest.mark.parametrize("mode",["rules","fake"])
def test_internal_shortage_facts_and_composer_cannot_drop_warning(mode):
    async def run():
        b,i,r=build(mode)
        chat=ChatSession(b.data(),b.scope(),i,r)
        turn=await chat.send("عايزة 10 تيشيرت أسود مقاس L",context_token=b.token(b.scope()))
        plan=turn.execution.plan
        assert plan.requested_quantity==10 and plan.review_reason==ReviewReason.OUT_OF_STOCK_RISK
        assert next(v for v in plan.variants if v.variant_id in plan.matching_variant_ids).recorded_quantity==4
        clauses,questions=clauses_for(plan)
        assert questions and any("مش متاحة بالكامل" in c.text for c in clauses)
        with pytest.raises(StructuredOutputError):
            validate_composition(NaturalReply(sentences=[Sentence(fact_ids=[clauses[0].id],join="and")],
                warmth="neutral",question_style="direct"),clauses)
        fallback=r.fallback(plan,"forced")
        assert "المسؤول" in fallback.response.reply and "4" not in fallback.response.reply
        customer_copy(fallback.response.reply)
    asyncio.run(run())


@pytest.mark.parametrize("allowed",[False,True])
@pytest.mark.parametrize("asked",[False,True])
def test_exact_count_requires_both_explicit_question_and_tenant_policy(allowed,asked):
    h=OfflineHarness(stock_quantity_disclosure_businesses=(identifier(1,1),) if allowed else ())
    response=send(h,"black tshirt size L price")
    if asked:
        response=send(h,"How many left in stock?")
    assert ("4 units" in response["reply"]) == (allowed and asked)
    assert "recorded stock" not in response["reply"]


@pytest.mark.parametrize("message,fragments,review",[
    ("عايزة 3 تيشيرت أسود مقاس L",("3","(متاح)"),False),
    ("عايزة 2 تيشيرت أبيض مقاس M",("2","التوافر محتاج تأكيد"),False),
    ("عندكم تيشيرت أزرق مقاس M؟",("مش متاح دلوقتي",),False),
    ("عايزة 10 تيشيرت أسود مقاس L",("10","المسؤول","مش متاحة بالكامل"),True),
])
def test_inventory_customer_policy(message,fragments,review):
    h=OfflineHarness()
    response=send(h,message)
    assert all(s in response["reply"] for s in fragments),response
    assert response["requiresReview"] is review
    customer_copy(response["reply"])


@pytest.mark.parametrize("patch",[{"stockQuantity":None},{"trackInventory":False,"stockQuantity":4},
    {"stockQuantity":-1},{"stockQuantity":1.5}])
def test_invalid_inventory_never_becomes_stock_or_review_evidence(patch):
    h=OfflineHarness()
    h.backend.products[1][0]["variants"][1].update(patch)
    response=send(h,"عايزة 10 تيشيرت أسود مقاس L")
    assert not response["requiresReview"] and "275" not in response["reply"]
    assert "متاحة بالكامل" not in response["reply"]


def test_comparison_after_purchase_and_cancel():
    h=OfflineHarness()
    for text in PREFIX:
        send(h,text)
    response=send(h,"الأسود ولا الأبيض مقاس L أنهي أرخص؟")
    assert response["intent"]=="INQUIRY" and not response["requiresReview"]
    assert all(v in response["reply"] for v in ("275","285","10"))
    response=send(h,"خلاص مش عايزة")
    assert response["intent"]=="OTHER" and "نسيب الاختيار" in response["reply"]


@pytest.mark.parametrize("status",["partial","unavailable"])
def test_correction_with_untrusted_history_asks_without_catalog_guess(status):
    h=OfflineHarness()
    result=h.send(h.body(CORRECTION,history_status=status))
    assert result.status_code==200
    response=result.json()
    assert "تقصد أنهي منتج" in response["reply"]
    assert [c["tool"] for c in h.calls]==["get_conversation_history"]
    assert response["orderCandidate"] is None and not response["requiresReview"]


def test_disclosure_policy_does_not_apply_to_another_business():
    h=OfflineHarness(stock_quantity_disclosure_businesses=(identifier(1,1),))
    for message in ("black tshirt size L price","How many left in stock?"):
        result=h.send(h.body(message,business=2))
        assert result.status_code==200
    assert "units" not in result.json()["reply"]


@pytest.mark.parametrize("mode",["rules","fake"])
def test_blue_correction_preserves_product_and_size_without_substitution(mode):
    async def run():
        b,i,r=build(mode)
        chat=ChatSession(b.data(),b.scope(),i,r)
        await chat.send("black tshirt size L price",context_token=b.token(b.scope()))
        turn=await chat.send("طب خليها الأزرق بدل الأسود",context_token=b.token(b.scope()))
        assert dict(turn.understanding.inquiry.option_values)=={"color":"Blue","size":"L"}
        assert tuple(map(str,turn.understanding.inquiry.product_ids))==(b.products[1][0]["id"],)
        assert "205" not in turn.response.reply
    asyncio.run(run())


def test_model_focus_cannot_authorize_stock_disclosure_without_customer_question():
    async def run():
        b,i,r=build("fake")
        i.settings=replace(i.settings,stock_quantity_disclosure_businesses=(str(b.scope().business_id),))
        chat=ChatSession(b.data(),b.scope(),i,r)
        message="black tshirt size L price"
        understood=await i.understand(message,chat.selection)
        forged=replace(understood,meaning=understood.meaning.model_copy(update={"focus":"stock"}))
        turn=await chat.send(message,context_token=b.token(b.scope()),prepared_understanding=forged)
        assert not turn.execution.plan.allow_stock_quantity_disclosure
        assert "4 units" not in turn.response.reply
    asyncio.run(run())

