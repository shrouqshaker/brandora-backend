"""Question-focused composition of typed evidence into natural sales replies.

The model composes sentences from fact references, not arbitrary factual prose.
Each reference renders current immutable slots. Mandatory warnings are attached
to the variant they qualify and cannot be dropped, moved to another variant or
replaced by a provider. This is a compositional grammar, not whole-reply templates.
"""
import asyncio
from dataclasses import dataclass
import json
from typing import Literal

from pydantic import Field, StrictStr

from ..nlu import norm_color
from ..pipeline.evidence_guard import compile_manifest, GroundingLimits
from ..pipeline.evidence_planner import Resolution
from ..pipeline.price_comparison import compare_verified_pair
from ..providers.base import ProviderUnavailable
from ..providers.evidence import GroundedGeneration
from ..providers.structured import GeminiJSONModel, parse_structured, StructuredOutputError, classify_failure
from ..schemas.backend import InventoryState
from ..schemas.response import E03Intent, ReviewReason
from .responding import ConversationalResponder


class Sentence(GeminiJSONModel):
    fact_ids: list[StrictStr] = Field(min_length=1, max_length=16)
    join: Literal["and", "sentences", "semicolon"]


class NaturalReply(GeminiJSONModel):
    sentences: list[Sentence] = Field(min_length=1, max_length=24)
    warmth: Literal["neutral", "friendly"]
    question_style: Literal["direct", "gentle"]


@dataclass(frozen=True)
class FactClause:
    id: str
    text: str
    kind: str


def money(value, language, script="native"):
    # Decimal formatting only; no binary float or derived/invented price.
    amount = format(value, "f").rstrip("0").rstrip(".") if "." in format(value,"f") else format(value,"f")
    return f"{amount} geneh" if script == "franco" else f"{amount} جنيه" if language == "ar" else f"{value:.2f} EGP"


def option_label(options, language, *, common_size=None, script="native"):
    labels = []
    color_ar = {"اسود":"الأسود", "ابيض":"الأبيض", "ازرق":"الأزرق", "احمر":"الأحمر",
                "اخضر":"الأخضر", "رمادي":"الرمادي", "بيج":"البيج", "وردي":"الوردي"}
    for key,value in options:
        if key.lower() in {"color","colour"} or key in {"اللون","لون"}:
            franco={"اسود":"el eswed","ابيض":"el abyad","ازرق":"el azra2","احمر":"el a7mar","اخضر":"el akhdar"}
            labels.append(franco.get(norm_color(value),value) if script == "franco" else color_ar.get(norm_color(value), value) if language == "ar" else value)
        elif key.lower() == "size" or key in {"مقاس","المقاس"}:
            labels.append(("b nafs el ma2as" if script == "franco" else "بنفس المقاس" if language == "ar" else "in the same size") if common_size == value
                          else (f"ma2as {value}" if script == "franco" else f"مقاس {value}" if language == "ar" else f"size {value}"))
        else:
            labels.append(f"{key} {value}")
    return " ".join(labels)


def stock_review(plan):
    matches = [v for v in plan.variants if v.variant_id in plan.matching_variant_ids]
    return (plan.review_reason == ReviewReason.OUT_OF_STOCK_RISK
            and plan.intent == E03Intent.PURCHASE_INTENT and plan.resolution == Resolution.SINGLE_VARIANT
            and len(plan.products) == len(matches) == 1 and not plan.ambiguities
            and not set(plan.limitations)-{"recorded_observations_not_reservations","no_stable_snapshot"}
            and matches[0].active and matches[0].parent_active and matches[0].options_verified
            and matches[0].recorded_quantity is not None and plan.requested_quantity is not None
            and plan.requested_quantity > matches[0].recorded_quantity)


def clauses_for(plan):
    compile_manifest(plan, GroundingLimits())
    if (plan.requires_review and not stock_review(plan)) or plan.resolution in {Resolution.SIMPLE_RESPONSE,Resolution.UNSUPPORTED,
            Resolution.UNAVAILABLE,Resolution.INVALID,Resolution.AUTHORIZATION_FAILED,Resolution.SCOPE_MISMATCH,
            Resolution.BUSINESS_INFO} or not plan.products:
        return (), ()
    ar = plan.language == "ar"
    franco = plan.reply_script == "franco"
    clauses, questions = [], []
    def add(text,kind):
        clauses.append(FactClause(f"f{len(clauses)}",text,kind))
    if len(plan.products) > 1:
        add(" / ".join(p.name for p in plan.products if p.active),"products")
        questions.append(("تقصد أنهي منتج؟", "ممكن تحدد المنتج اللي تقصده؟") if ar
                         else ("Which product do you mean?", "Which of these products did you mean?"))
        return tuple(clauses),tuple(questions)
    product = plan.products[0]
    matched = [v for v in plan.variants if v.variant_id in plan.matching_variant_ids
               and v.active and v.parent_active and v.options_verified]
    if not product.active or not matched:
        add("مش قادر أتحقق من اختيار نشط بالمواصفات دي" if ar
            else "I can't verify an active variant matching those selections", "unverified")
        questions.append(("تحب نشوف لون أو مقاس تاني؟",)*2 if ar else ("Would you like to check another color or size?",)*2)
    first_size = None
    # Arabic customer-facing list: say the shared option once ("باللون الأسود") instead of repeating it per variant.
    shared = {}
    if ar and not franco and not plan.comparison and len(matched) > 1:
        for key in {k for v in matched for k,_ in v.option_values}:
            values = {dict(v.option_values).get(key) for v in matched}
            if len(values) == 1 and None not in values:
                shared[key] = values.pop()
    avail_focus = {"availability","stock","purchase"} if ar and not franco else {"availability","stock"}
    untracked_focus = {"availability","purchase","stock"} if ar and not franco else {"availability","purchase","discovery","stock"}
    for index,v in enumerate(matched[:6]):
        size = next((value for key,value in v.option_values if key.lower() == "size" or key in {"مقاس","المقاس"}),None)
        label = option_label([(k,val) for k,val in v.option_values if k not in shared], plan.language,
                             common_size=first_size if plan.comparison else None,script=plan.reply_script)
        label = label or product.name
        if index == 0:
            first_size = size
        focus = plan.reply_focus
        show_price = (plan.show_price or focus != "purchase" or plan.comparison) and focus != "stock"
        if show_price:
            text = (f"{label} b {money(v.effective_price,plan.language,plan.reply_script)}" if franco else f"{label} بـ{money(v.effective_price,plan.language)}" if ar else f"{label}: {money(v.effective_price,plan.language)}") if v.effective_price is not None else (
                f"سعر {label} مش مؤكد" if ar else f"{label}: price unconfirmed")
            if franco and v.effective_price is None:
                text = f"se3r {label} mesh met2akked"
        else:
            text = label
        if plan.intent == E03Intent.PURCHASE_INTENT and plan.requested_quantity is not None and len(matched) == 1:
            q=plan.requested_quantity
            text=(f"lel {q} ket3a men {text}" if franco else f"بالنسبة للـ{q} قطع من {text}" if ar
                  else f"For {q} units of {text}")
            if show_price and v.effective_price is not None:
                text += " lel ket3a" if franco else " للقطعة" if ar else " per unit"
        # Inventory remains internal unless explicitly requested AND permitted
        # by operator-owned tenant policy. No observation is a reservation.
        if v.inventory == InventoryState.RECORDED_ZERO:
            text += "; mesh metah delwa2ty" if franco else " (مش متاح دلوقتي)" if ar else "; currently out of stock according to the latest information"
        elif focus == "stock" and v.recorded_quantity is not None and plan.allow_stock_quantity_disclosure:
            text += f"; el metah {v.recorded_quantity}, mehtag ta2keed" if franco else f" (المتاح {v.recorded_quantity} قطعة)" if ar else f"; latest availability: {v.recorded_quantity} units; final availability needs confirmation"
        elif focus in avail_focus and v.inventory == InventoryState.RECORDED_POSITIVE:
            text += "; el tawafor mehtag ta2keed" if franco else " (متاح)" if ar else "; appears available according to the latest information; final availability needs confirmation"
        elif focus in untracked_focus and v.inventory == InventoryState.UNTRACKED:
            text += "; el tawafor mehtag ta2keed" if franco else "، والتوافر محتاج تأكيد" if ar else "; availability needs confirmation"
        if v.effective_price is None and not show_price and focus != "stock":
            text += "; el se3r lesa mesh met2akked" if franco else "، والسعر لسه مش مؤكد" if ar else "; price unconfirmed"
        if shared and index == 0:
            parts = [("باللون " if k.lower() in {"color","colour"} or k in {"اللون","لون"} else "") + option_label([(k,val)], plan.language)
                     for k,val in shared.items()]
            text = f"عندنا {product.name} {' '.join(parts)}: {text}"
        add(text,"variant")
        if plan.requested_quantity is not None and v.recorded_quantity is not None and plan.requested_quantity > v.recorded_quantity:
            add("el kammiya mesh metaha bel kamel delwa2ty" if franco else "الكمية دي مش متاحة بالكامل حاليًا" if ar
                else "the full requested quantity is not currently available", "quantity_unavailable")
    if len(matched) > 6:
        add("فيه اختيارات تانية كمان؛ المعروض هنا جزء منها" if ar
            else "More verified variants exist; these are only some of them", "more_options")
    comparison = compare_verified_pair(plan)
    if comparison is not None:
        by_id = {v.variant_id:v for v in matched}
        lower = option_label(by_id[comparison.lower_id].option_values,plan.language,script=plan.reply_script)
        if comparison.difference == 0:
            text = "el etneen b nafs el se3r" if franco else "الاتنين بنفس السعر" if ar else "Both variants have the same price"
        else:
            difference = money(comparison.difference,plan.language,plan.reply_script)
            text = f"{lower} arkhas b {difference}" if franco else f"{lower} أرخص بـ{difference}" if ar else f"{lower} is cheaper by {difference}"
        add(text,"verified_price_difference")
    elif plan.comparison and plan.comparison_metric == "price":
        add("el far2 mehtag se3r mo2akkad lel ekhteyareen" if franco else "محتاج سعر مؤكد لكل بديل مطلوب عشان أقارن بينهم" if ar
            else "A confirmed price for each requested alternative is needed for comparison", "comparison_unverified")
    if len(matched) > 1 and comparison is None:
        keys = [key for key,_ in product.declared_options if len({dict(v.option_values).get(key) for v in matched}) > 1]
        readable = {"color":"لون", "colour":"لون", "size":"مقاس"}
        label = " / ".join(readable.get(k,k) for k in keys) if ar else " / ".join(keys)
        questions.append(("anhi ekhteyar ynasebak?","t7eb anhi ekhteyar?") if franco else (f"أنهي {label} يناسبك أكتر؟",f"تميل لأنهي {label}؟") if ar
                         else (f"Which {label} do you prefer?",f"Which {label} would you like?"))
    if plan.comparison and len(matched) < 2:
        add("مش كل البدائل المطلوبة اتأكدت؛ مش معنى كده إنها مش موجودة" if ar
            else "Not all requested alternatives could be verified; this doesn't prove they are absent", "incomplete")
    if plan.intent == E03Intent.PURCHASE_INTENT:
        q = plan.requested_quantity
        if q is not None:
            if len(matched) != 1:
                add(f"el matloob {q} ket3a" if franco else f"الكمية المطلوبة مبدئيًا {q} قطع" if ar
                    else f"Requested quantity: {q}", "purchase")
            if stock_review(plan):
                questions.append(("nerage3 el tawafor ma3 el mas2ool?",)*2 if franco else
                    ("نراجع إمكانية توفير الكمية مع المسؤول؟",)*2 if ar else
                    ("Would you like the team to review availability for this quantity?",)*2)
            elif len(matched) == 1 and matched[0].inventory == InventoryState.RECORDED_POSITIVE and not (ar and not franco):
                add("el tawafor el neha2y mehtag ta2keed" if franco else "التوافر النهائي محتاج تأكيد" if ar
                    else "Final availability needs confirmation", "availability_caveat")
        else:
            questions.append(("mehtag kam ket3a?","t7eb kam ket3a?") if franco else ("محتاج كام قطعة؟","تحب كام قطعة؟") if ar else ("How many would you like?","What quantity would you like?"))
    if "variant_search_incomplete" in plan.limitations or "partial_catalog_not_globally_unique" in plan.limitations:
        add("ممكن يكون فيه اختيارات تانية لسه ما اتأكدتش منها" if ar else "There may be other options I haven't confirmed yet", "partial")
    return tuple(clauses),tuple(questions)


def validate_composition(proposal, clauses):
    if not isinstance(proposal,NaturalReply):
        raise StructuredOutputError("grounding_guard_rejected")
    ids = [identifier for sentence in proposal.sentences for identifier in sentence.fact_ids]
    if ids != [c.id for c in clauses]:
        raise StructuredOutputError("grounding_guard_rejected")
    return proposal


def render(plan, proposal, clauses, questions):
    lookup = {c.id:c.text for c in clauses}
    ar = plan.language == "ar"
    franco = plan.reply_script == "franco"
    sentences = []
    for sentence in proposal.sentences:
        join = (" w " if franco else "، و" if ar else ", and ") if sentence.join == "and" else ("; " if franco else "؛ " if ar else "; ") if sentence.join == "semicolon" else ". "
        sentences.append(join.join(lookup[i] for i in sentence.fact_ids))
    reply = ". ".join(sentences)
    if proposal.warmth == "friendly" and not plan.comparison:
        reply = ("tamam, " if franco else "تمام، " if ar else "Sure, ") + reply
    if questions:
        reply += ". " + " ".join(pair[proposal.question_style == "gentle"] for pair in questions)
    return plan.to_response().model_copy(update={"reply":reply})


class NaturalResponder(ConversationalResponder):
    """Provider-independent guarded composer used by every local chat mode."""
    def fallback(self, plan, reason, violations=()):
        try:
            clauses, questions = clauses_for(plan)
            if clauses:
                proposal = NaturalReply(sentences=[Sentence(fact_ids=[c.id for c in clauses],join="and")],
                                        warmth="neutral",question_style="direct")
                return GroundedGeneration(render(plan,proposal,clauses,questions),"deterministic",
                                          fallback_reason=reason,guard_violations=tuple(violations))
        except (ValueError,TypeError,AttributeError):
            pass
        return super().fallback(plan,reason,violations)

    async def generate(self,plan):
        try:
            clauses,questions = clauses_for(plan)
        except (ValueError,TypeError,AttributeError):
            return self.fallback(plan,"invalid_plan")
        if not clauses:
            return self.fallback(plan,"protected_plan")
        default = NaturalReply(sentences=[Sentence(fact_ids=[c.id for c in clauses],join="and")],
                               warmth="neutral",question_style="direct")
        proposal,source,model,failure,diagnostics = default,"conversational_rules",None,None,()
        if self.client is not None:
            payload = {"language":plan.language,"focus":plan.reply_focus,"comparison":plan.comparison,
                       "facts":[{"id":c.id,"clause":c.text,"kind":c.kind} for c in clauses],
                       "questionsRequired":bool(questions)}
            def parse(text):
                return validate_composition(parse_structured(NaturalReply,text),clauses)
            try:
                prompt = json.dumps(payload,ensure_ascii=False)
                if len(prompt) > 16000:
                    raise StructuredOutputError("prompt_limit")
                provider_result = await asyncio.wait_for(self.client.call(stage="conversation-reply",models=self.settings.generator_models,
                    system=("Compose a concise natural sales reply, especially Egyptian Arabic. Group related verified clauses "
                            "into sentences with appropriate conjunctions. Use every fact id exactly once, in supplied order. "
                            "Choose warmth and question style for the customer. No free prose, new facts, prices, preferences "
                            "or order actions. Never imply a notification, reservation, stock guarantee or restock promise. "
                            "Inventory disclosure and review offers are controlled by Python; preserve every warning. "
                            "Questions and factual slots are rendered by Python. Return NaturalReply JSON."),
                    user=prompt,schema=NaturalReply,parse=parse,temperature=0.3,mime="application/json"),
                    timeout=self.settings.chat_total_timeout_seconds + 1)
                proposal,model = provider_result
                validate_composition(proposal,clauses)
                source = getattr(provider_result,"provider","gemini") + "_conversation"
                diagnostics = getattr(provider_result,"failures",())
            except Exception as error:
                proposal = default
                failure = "reply_unavailable_or_guard_rejected"
                diagnostics = error.diagnostics if isinstance(error,ProviderUnavailable) else (classify_failure(error,"parse"),)
        response = render(plan,proposal,clauses,questions)
        if len(response.reply) > 20000:
            return self.fallback(plan,"reply_limit")
        return GroundedGeneration(response,source,model=model,fallback_reason=failure,provider_diagnostics=diagnostics)
