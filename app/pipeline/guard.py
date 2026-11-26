"""Grounding guard: checks what the Generator wrote against the verified draft.

If ANY check fails the orchestrator discards the generated text and sends the template draft instead, so a creative
or hallucinating model can never put a wrong price, a promise, or an "order accepted" claim in front of a customer.
"""
from __future__ import annotations

import re

from ..nlu import normalize
from ..prompts.templates import (CANCEL_CONFIRM_MARKERS, CLARIFICATION_MARKERS, CONFIRM_MARKERS,
                                 MODIFY_CONFIRM_MARKERS)
from ..schemas import Language, Plan

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_ARABIC = re.compile(r"[\u0600-\u06FF]")
_LATIN = re.compile(r"[A-Za-z]")
_BULLET = re.compile(r"^\s*(?:[-*•·]|\d+[.)])\s+", re.M)
# The service is stateless: it knows an order summary / a cancel question / an open question is pending ONLY because its own
# previous message (stored by the backend) contains one of these phrases. A rewrite that drops them silently breaks the
# customer's next "ايوه", so the guard insists they survive.
_MARKER_FAMILIES = tuple(tuple(normalize(m) for m in family) for family in (
    CONFIRM_MARKERS, CANCEL_CONFIRM_MARKERS, MODIFY_CONFIRM_MARKERS, CLARIFICATION_MARKERS))
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B50\u2B06\u2194-\u21AA]")
_MARKDOWN = re.compile(r"\*\*|__|`|^#{1,6}\s", re.M)

# promises the system cannot keep + claims that an order was accepted (only the owner approves orders)
FORBIDDEN = (
    "هراجع مع الفريق", "هسأل الفريق", "هبلغ الفريق", "هتواصل مع الفريق", "هراجع مع صاحب", "هتابعه",
    "تم قبول", "اتقبل طلبك", "تم تأكيد طلبك", "طلبك اتأكد", "طلبك اتسجل", "تم تسجيل طلبك", "تم الحجز", "تم استلام طلبك",
    "order has been accepted", "order is confirmed", "order confirmed", "order has been placed", "accepted your order",
    "your order is placed", "check with the team", "i'll check with", "i will check with", "will follow up",
    # the AI can neither cancel/change an order nor refund/forward anything: it must not say so
    "تم إلغاء طلبك", "تم الغاء طلبك", "طلبك اتلغى", "تم تعديل طلبك", "تم رد", "هنرجعلك فلوسك", "هيتم استرداد",
    "تم تحويل شكواك", "هبلغ صاحب المحل", "هوصل شكواك", "تم ابلاغ صاحب",
    "order has been cancelled", "order has been canceled", "your order is cancelled", "your order was cancelled",
    "has been modified", "has been changed", "refund has been", "we will refund", "will be refunded",
    "i will notify the owner", "i'll tell the owner", "i have passed", "i've passed",
)


def _numbers(text: str) -> set[str]:
    return {n.replace(",", ".") for n in _NUMBER.findall(text.translate(_DIGITS))}


def check_reply(reply: str, plan: Plan, language: Language) -> list[str]:
    """Return the list of violated rules (empty = the generated reply is safe to send)."""
    problems: list[str] = []
    text = (reply or "").strip()
    if not text:
        return ["empty"]
    low = text.casefold()
    norm_text = normalize(text)
    norm_draft = normalize(plan.reply)

    extra_numbers = _numbers(text) - _numbers(plan.reply)
    if extra_numbers:
        problems.append(f"new numbers {sorted(extra_numbers)}")
    for term in plan.protected_terms:
        if term and term.casefold() not in low:
            problems.append(f"dropped product name {term!r}")
    for phrase in FORBIDDEN:
        if phrase.casefold() in low or normalize(phrase) in norm_text:
            problems.append(f"forbidden phrase {phrase!r}")
    for family in _MARKER_FAMILIES:
        if any(m in norm_draft for m in family) and not any(m in norm_text for m in family):
            problems.append("lost the conversation-state phrase")
            break
    if "http" in low or "www." in low:
        problems.append("url")
    if _BULLET.search(text) or _MARKDOWN.search(text):
        problems.append("markdown/bullets")
    if _EMOJI.search(text):
        problems.append("emoji")
    if len(text) > max(len(plan.reply) * 2 + 40, 140):
        problems.append("too long")
    ar, la = len(_ARABIC.findall(text)), len(_LATIN.findall(text))
    if language == "ar" and ar < 2:
        problems.append("not Arabic")
    if language == "en" and ar > len(_ARABIC.findall(plan.reply)):
        problems.append("not English")   # product names / owner text already in the draft may stay Arabic; nothing new
    asked = plan.reply.rstrip().endswith(("?", "؟"))
    if asked and "?" not in text and "؟" not in text:
        problems.append("lost the question")
    if plan.candidate is None and normalize(text) == "":
        problems.append("empty after normalisation")
    return problems
