"""Handoff hardening: (1) the guard protects the phrases the stateless service reads back from its own replies,
(2) English order flow, (3) PROOF that FAQ rows straight from PostgreSQL work with no code change, (4) mock isolation."""
import copy
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from app.pipeline.context import MAX_FAQS, build_context
from app.pipeline.guard import check_reply
from app.schemas import AIRespondRequest, Intent, Plan
from tests.fake_gemini import router_json
from tests.helpers import rules_orchestrator, run_payload
from tests.test_catalog_policy import payload
from tests.test_pipeline_gemini import go, pipeline

ROOT = Path(__file__).resolve().parent.parent


# ================================================================= (1) conversation-state phrases survive any rewrite
@pytest.mark.parametrize("draft,rewrite,ok", [
    ("تمام! X، كمية 2.\nتحب تأكد الطلب؟", "تمام! X، كمية 2. عايز نكمل؟", False),
    ("تمام! X، كمية 2.\nتحب تأكد الطلب؟", "تمام يا فندم! X، كمية 2.\nتحب تأكد الطلب؟", True),
    ("Got it! X, quantity 2.\nWould you like to confirm the order?", "Got it! X, quantity 2. Shall we go ahead?", False),
    ("Got it! X, quantity 2.\nWould you like to confirm the order?", "Got it! X, quantity 2.\nWould you like to confirm the order?", True),
    ("عايز تلغي طلب رقم 1002 (x)؟ اكتب (ايوه) لتأكيد الإلغاء.", "عايز تلغي طلب رقم 1002 (x)؟ قولي نعم.", False),
    ("عايز تعدّل طلب رقم 1002 (x)؟ اكتب (ايوه) لتأكيد التعديل.", "عايز تعدّل طلب رقم 1002 (x)؟ اكتب (ايوه) لتأكيد التعديل.", True),
    ("تمام، X. تحب أنهي لون ومقاس؟ وكام واحدة؟", "قولي اللون والمقاس والكمية", False),
    ("تمام، X. تحب أنهي لون ومقاس؟ وكام واحدة؟", "تمام، X. تحب أنهي لون ومقاس؟ وكام واحدة؟", True),
    ("Sure, X. How many would you like?", "Sure, X. Quantity?", False),
    ("Sure, X. How many would you like?", "Sure, X. How many would you like?", True),
    ("عندنا X بـ 100 جنيه.", "X بـ 100 جنيه.", True),            # a plain answer has no state phrase to protect
])
def test_guard_keeps_the_state_phrases(draft, rewrite, ok):
    lang = "en" if draft.isascii() else "ar"
    problems = check_reply(rewrite, Plan(Intent.CREATE_ORDER, draft, protected_terms=["X"] if "X" in draft else []), lang)
    assert ("lost the conversation-state phrase" not in problems) is ok, problems


def test_a_reworded_summary_cannot_break_the_customers_confirmation():
    orch, _ = pipeline({"r-a": router_json(["CREATE_ORDER"], product_query="T-Shirt", quantity=2),
                        "g-a": "ماشي! T-Shirt، كمية 2، يعني الحساب 599.98 جنيه. عايز نكمل؟"})
    first, trace, _ = go(orch, payload("هاخد 2 T-Shirt"))
    assert "lost the conversation-state phrase" in trace.guard_violations
    assert first.reply == "تمام! T-Shirt، كمية 2، الإجمالي 599.98 جنيه.\nتحب تأكد الطلب؟"
    confirmed, _, _ = go(orch, payload("ايوه اكد", history=[("c", "هاخد 2 T-Shirt"), ("a", first.reply)]))
    assert confirmed.intent.value == "CONFIRMED_ORDER" and confirmed.orderCandidate.items[0].quantity == 2


def test_a_friendly_rewrite_that_keeps_the_sentence_is_accepted():
    orch, _ = pipeline({"r-a": router_json(["CREATE_ORDER"], product_query="T-Shirt", quantity=2),
                        "g-a": "تمام يا فندم! T-Shirt، كمية 2، الإجمالي 599.98 جنيه.\nتحب تأكد الطلب؟"})
    response, trace, _ = go(orch, payload("هاخد 2 T-Shirt"))
    assert not trace.guard_violations and response.reply.startswith("تمام يا فندم!")


def test_the_generator_is_told_to_keep_those_sentences():
    from app.prompts.generator import GENERATOR_SYSTEM_PROMPT
    assert "KEEP WORD FOR WORD" in GENERATOR_SYSTEM_PROMPT and "تحب تأكد الطلب؟" in GENERATOR_SYSTEM_PROMPT


# ================================================================= (2) English flow
def test_english_order_flow_end_to_end():
    o = rules_orchestrator()
    r1 = run_payload(o, payload("I'll take a hoodie"))
    assert r1.reply == "Sure, Updated Hoodie. How many would you like?" and r1.plan.clarification
    r2 = run_payload(o, payload("two", history=[("c", "I'll take a hoodie"), ("a", r1.reply)]))
    assert r2.reply == "Got it! Updated Hoodie, quantity 2, total 900 EGP.\nWould you like to confirm the order?"
    r3 = run_payload(o, payload("yes", history=[("c", "I'll take a hoodie"), ("a", r1.reply), ("c", "two"), ("a", r2.reply)]))
    assert r3.response.intent.value == "CONFIRMED_ORDER" and r3.candidate.items[0].quantity == 2
    assert r3.reply == "Great, I'll prepare your order for review: Updated Hoodie, quantity 2."


def test_english_questions_carry_the_markers_the_next_turn_needs():
    cat = copy.deepcopy(__import__("tests.railway_data", fromlist=["x"]).CATALOG)
    cat[6]["attributes"] = {"Color": "Black, White", "Size": "S, M, L"}
    o = rules_orchestrator()
    r = run_payload(o, payload("I'll take 1 T-Shirt", catalog=cat))
    assert r.reply.startswith("Sure, T-Shirt. Which color and size would you like?")
    ctx = build_context(AIRespondRequest.model_validate(payload("black L", catalog=cat, history=[("c", "x"), ("a", r.reply)])))
    assert ctx.mid_order is True
    done = run_payload(o, payload("black L", catalog=cat, history=[("c", "I'll take 1 T-Shirt"), ("a", r.reply)]))
    assert "T-Shirt Black size L, quantity 1" in done.reply


# ================================================================= (3) FAQ rows exactly as PostgreSQL returns them
def faq_row(question, answer, **extra):
    return {"id": str(uuid.uuid4()), "businessId": "0bfc71e2-0728-4d39-8103-8410b644f945", "question": question,
            "answer": answer, "isActive": True, "sortOrder": 0, "createdAt": "2026-10-20T10:00:00.000Z",
            "updatedAt": "2026-10-20T10:00:00.000Z", **extra}   # NO `keywords`: the table does not have that column


GYM = [
    faq_row("في مدرب شخصي؟", "أيوه، المدرب الشخصي بـ 300 جنيه للحصة."),
    faq_row("ينفع أجمد الاشتراك؟", "التجميد متاح مرة واحدة في السنة."),
    faq_row("في حمام سباحة؟", "لا، مفيش حمام سباحة."),
    faq_row("فيه ركنة للسيارات؟", "أيوه، الجراج مجاني للأعضاء."),
    faq_row("الاشتراك الشهري بكام؟", "الاشتراك الشهري 800 جنيه."),
    faq_row("في حصص يوجا؟", "حصص اليوجا يوم الثلاثاء والخميس."),
]


def with_faqs(text, faqs, **kw):
    return payload(text, knowledge={"faqs": copy.deepcopy(faqs)}, **kw)


@pytest.mark.parametrize("message,answer", [
    ("عندكم مدرب شخصي؟", "أيوه، المدرب الشخصي بـ 300 جنيه للحصة."),
    ("ينفع اجمد اشتراكي", "التجميد متاح مرة واحدة في السنة."),
    ("فيه حمام سباحه عندكم", "لا، مفيش حمام سباحة."),
    ("في ركنه للسيارات", "أيوه، الجراج مجاني للأعضاء."),
    ("عايز اعرف عن حصص اليوجا", "حصص اليوجا يوم الثلاثاء والخميس."),
])
def test_faq_rows_without_keywords_resolve_in_rules_mode(message, answer):
    r = run_payload(rules_orchestrator(), with_faqs(message, GYM))
    assert r.intent == Intent.GENERAL_INFO and r.reply == answer and r.response.requiresReview is False


@pytest.mark.parametrize("index", range(len(GYM)))
def test_the_routers_faq_id_resolves_every_row_by_the_number_in_the_prompt(index):
    """Whatever number the prompt shows next to a question is the number the pipeline resolves: no mapping table to maintain."""
    row = GYM[index]
    request = with_faqs("سؤال بصياغة مختلفة تمامًا", GYM)
    number = build_context(AIRespondRequest.model_validate(request)).faqs.index(
        next(f for f in GYM if f["id"] == row["id"])) + 1
    orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=number), "g-a": "x"})
    response, _, _ = go(orch, request)
    prompt = fake.prompts_for(("r-a",))[0]
    assert f"\n{number}. {row['question']}" in prompt              # the model saw the question under that number...
    assert response.reply == row["answer"]                         # ...and the answer was read from the data by it
    assert row["answer"] not in prompt                             # the answers never go to the model


def test_the_number_is_relative_to_the_list_of_this_request_so_row_order_does_not_matter():
    reordered = list(reversed(GYM))
    request = with_faqs("الاشتراك بكام؟", reordered)
    number = 2   # in the reversed list the monthly-price FAQ is 2nd (index 1)
    assert reordered[number - 1]["question"] == "الاشتراك الشهري بكام؟"
    orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=number), "g-a": "x"})
    response, _, _ = go(orch, request)
    assert "\n2. الاشتراك الشهري بكام؟" in fake.prompts_for(("r-a",))[0] and response.reply == "الاشتراك الشهري 800 جنيه."


def test_soft_deleted_blank_and_incomplete_rows_are_dropped_and_numbering_follows_the_clean_list():
    dirty = [faq_row("سؤال محذوف؟", "SOFT DELETED", isActive=False), GYM[0], faq_row("بدون إجابة؟", ""),
             faq_row("", "بدون سؤال"), GYM[1], faq_row("إجابة فاضية؟", None)]
    ctx = build_context(AIRespondRequest.model_validate(with_faqs("hi", dirty)))
    assert [f["question"] for f in ctx.faqs] == [GYM[0]["question"], GYM[1]["question"]]
    orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=2), "g-a": "x"})
    response, _, _ = go(orch, with_faqs("كلمة", dirty))
    assert response.reply == GYM[1]["answer"] and "SOFT DELETED" not in fake.prompts_for(("r-a",))[0]
    assert run_payload(rules_orchestrator(), with_faqs("سؤال محذوف", dirty)).reply != "SOFT DELETED"


def test_a_router_number_that_is_not_in_the_prompt_is_ignored_and_nothing_is_invented():
    orch, _ = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=len(GYM) + 1), "g-a": "x"})
    response, _, _ = go(orch, with_faqs("عندكم ساونا؟", GYM))
    assert response.reply.startswith("معلش معنديش معلومة مؤكدة")


def test_only_the_first_forty_faqs_are_resolvable():
    many = [faq_row(f"سؤال رقم {i} مختلف؟", f"إجابة {i}") for i in range(60)]
    ctx = build_context(AIRespondRequest.model_validate(with_faqs("hi", many)))
    assert len(ctx.faqs) == MAX_FAQS == 40 and ctx.faqs[-1]["answer"] == "إجابة 39"


def test_a_faq_never_steals_a_real_catalog_question():
    cat = copy.deepcopy(__import__("tests.railway_data", fromlist=["x"]).CATALOG)
    r = run_payload(rules_orchestrator(), with_faqs("التيشيرت بكام؟", [faq_row("التيشيرت بكام؟", "FAQ ANSWER")], catalog=cat))
    assert r.reply == "T-Shirt بـ 299.99 جنيه."   # the catalog is the source of truth for prices


# ================================================================= (4) the production path never loads mock data
def test_production_path_never_imports_the_mock_fixture():
    code = ("import os; os.environ['AI_PROVIDER']='rules'; import main, sys; "
            "from main import create_app; from app.config import Settings; create_app(Settings(ai_provider='rules')); "
            "print('mock_data' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True,
                         env={**os.environ, "PYTHONPATH": str(ROOT)})
    assert out.stdout.strip().splitlines()[-1] == "False", out.stderr


def test_owner_written_answers_are_sent_verbatim_the_generator_never_rephrases_them():
    orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], faq_topic="OTHER", faq_id=2),
                           "g-a": "ممكن نقول إن الاشتراك بـ 800 جنيه تقريبًا"})   # a drifting rewrite, if it were ever called
    response, trace, plan = go(orch, with_faqs("الاشتراك بكام؟", GYM))
    assert response.reply == GYM[1]["answer"]   # FAQ #2 verbatim, whatever the model might have preferred to say
    assert plan.grounded is False and "g-a" not in fake.models_called()
    for text in ("بتفتحوا امتى؟", "بتوصلوا؟", "ينفع ادفع كاش؟", "إزاي أرجع المنتج؟"):
        orch, fake = pipeline({"r-a": router_json(["GENERAL_INFO"], confidence=0.9), "g-a": "x"})
        go(orch, payload(text, knowledge={"policies": {"returns": "14 يوم"}}))
        assert "g-a" not in fake.models_called(), text
