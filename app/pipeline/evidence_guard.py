"""Closed-format evidence guard; no semantic approval of arbitrary model prose.

Trusted input is an EvidencePlanner-produced plan from scoped retrieval. This
guard proves presentation preserves the approved blocks, not Backend truth,
authorization, freshness or arbitrary caller-supplied plan authenticity.
"""
from dataclasses import dataclass, field
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictStr

from .evidence_planner import EvidencePlan, Resolution
from ..schemas.response import AiResponse, E03Intent


class Presentation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    opening: Literal["none", "acknowledge", "helpful"]
    layout: Literal["compact", "spaced"]
    statement_ids: list[StrictStr] = Field(max_length=64)


@dataclass(frozen=True)
class GroundingLimits:
    max_prompt_characters: int = 16000
    max_statements: int = 32
    max_proposal_characters: int = 4096
    max_reply_characters: int = 20000
    max_elapsed_seconds: float = 25.0

    def __post_init__(self):
        import math
        for value in (self.max_prompt_characters, self.max_statements,
                      self.max_proposal_characters, self.max_reply_characters):
            if type(value) is not int or value <= 0:
                raise ValueError("Grounding limits must be positive integers")
        if self.max_statements > 64:
            raise ValueError("Grounding statement limit exceeds presentation schema")
        if self.max_reply_characters < 128:
            raise ValueError("Reply limit must leave room for a safe generic fallback")
        if (isinstance(self.max_elapsed_seconds, bool)
                or not isinstance(self.max_elapsed_seconds, (int, float))
                or not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0):
            raise ValueError("Grounding deadline must be positive and finite")


@dataclass(frozen=True)
class StatementManifest:
    ids: tuple[str, ...]
    blocks: tuple[str, ...] = field(repr=False)
    language: str


_OPENINGS = {
    "en": {"none": "", "acknowledge": "Here is the recorded information.",
           "helpful": "Let me outline the recorded information."},
    "ar": {"none": "", "acknowledge": "تمام، دي المعلومات المسجلة.",
           "helpful": "أوضحلك المعلومات المسجلة."},
}
_KINDS = frozenset({"authorization_unavailable", "scope_mismatch", "owner_review", "hard_rule", "help",
                    "unsupported", "business_identity", "information_unverified", "product_identity",
                    "inactive_product", "inactive_variant", "variant_observation", "clarification", "observation_limit"})
_TOOLS = frozenset({"get_products", "get_product_details", "get_product_variants", "get_variant_details", "get_business_info"})
_RECORD_PATH = re.compile(r"data(?:\.items\[\d+\])?(?:\.variants\[\d+\])?")


class InvalidEvidencePlan(ValueError):
    """Safe category only; do not include plan/customer data in the message."""


def validate_plan(plan: EvidencePlan) -> None:
    if not isinstance(plan, EvidencePlan) or plan.language not in _OPENINGS or plan.intent not in {
            E03Intent.INQUIRY, E03Intent.PURCHASE_INTENT, E03Intent.OTHER}:
        raise InvalidEvidencePlan("invalid_plan")
    if not plan.statements or not isinstance(plan.requires_review, bool):
        raise InvalidEvidencePlan("invalid_plan")
    if plan.resolution in {Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH} and (
            plan.products or plan.variants or plan.matching_variant_ids or plan.selected_variant_id):
        raise InvalidEvidencePlan("invalid_plan")
    products = {p.product_id: p for p in plan.products}
    variants = {v.variant_id: v for v in plan.variants}
    if len(products) != len(plan.products) or len(variants) != len(plan.variants):
        raise InvalidEvidencePlan("invalid_plan")
    if any(identifier not in variants for identifier in plan.matching_variant_ids) or (
            plan.selected_variant_id is not None and plan.selected_variant_id not in plan.matching_variant_ids):
        raise InvalidEvidencePlan("invalid_plan")
    if plan.requires_clarification and not any(s.kind in {"clarification", "information_unverified"} for s in plan.statements):
        raise InvalidEvidencePlan("invalid_plan")
    for statement in plan.statements:
        if statement.kind not in _KINDS or not statement.text.strip() or not statement.sources:
            raise InvalidEvidencePlan("invalid_plan")
        for source in statement.sources:
            valid = ((source.tool in _TOOLS and type(source.envelope_index) is int and source.envelope_index >= 0
                      and _RECORD_PATH.fullmatch(source.path) is not None)
                     or (source.tool == "application_policy" and source.envelope_index is None and source.path == "currency.EGP")
                     or (source.tool == "deterministic_template" and source.envelope_index is None and source.path == "read_only_safety"))
            if not valid:
                raise InvalidEvidencePlan("invalid_plan")
        if statement.kind in {"product_identity", "inactive_product", "inactive_variant", "variant_observation"}:
            parent = products.get(statement.product_id)
            if parent is None or parent.source not in statement.sources:
                raise InvalidEvidencePlan("invalid_plan")
        if statement.kind in {"inactive_variant", "variant_observation"}:
            variant = variants.get(statement.variant_id)
            if variant is None or variant.product_id != statement.product_id or variant.source not in statement.sources:
                raise InvalidEvidencePlan("invalid_plan")
            if statement.kind == "variant_observation" and (
                    not parent.active or not variant.parent_active or not variant.active or not variant.options_verified
                    or variant.variant_id not in plan.matching_variant_ids):
                raise InvalidEvidencePlan("invalid_plan")
    if any(v.product_id not in products for v in plan.variants):
        raise InvalidEvidencePlan("invalid_plan")
    plan.to_response()  # Existing schema and read-only intent/candidate invariant.


def compile_manifest(plan: EvidencePlan, limits: GroundingLimits) -> StatementManifest:
    validate_plan(plan)
    if len(plan.statements) > limits.max_statements:
        raise InvalidEvidencePlan("statement_limit")
    return StatementManifest(tuple(f"s{index}" for index in range(len(plan.statements))),
                             tuple(s.text for s in plan.statements), plan.language)


def parse_presentation(text: str | None, max_characters: int = 4096) -> Presentation:
    if not isinstance(text, str) or len(text) > max_characters:
        raise ValueError("invalid_presentation")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("invalid_presentation")
            result[key] = value
        return result
    # Reject duplicate JSON keys and all free-text/unknown fields. GeminiClient
    # retries these parse errors using its existing sanitized retry mechanism.
    return Presentation.model_validate(json.loads(text, object_pairs_hook=unique))


def guard_presentation(proposal: Presentation, manifest: StatementManifest) -> tuple[str, ...]:
    return () if isinstance(proposal, Presentation) and tuple(proposal.statement_ids) == manifest.ids else ("statement_manifest_mismatch",)


def render_presentation(plan: EvidencePlan, proposal: Presentation, manifest: StatementManifest,
                        limits: GroundingLimits) -> AiResponse:
    if guard_presentation(proposal, manifest):
        raise ValueError("statement_manifest_mismatch")
    separator = "\n" if proposal.layout == "compact" else "\n\n"
    blocks = list(manifest.blocks)
    opening = _OPENINGS[manifest.language][proposal.opening]
    if opening:
        blocks.insert(0, opening)
    reply = separator.join(blocks)
    if len(reply) > limits.max_reply_characters:
        raise ValueError("reply_limit")
    return AiResponse(intent=plan.intent, reply=reply, requiresReview=plan.requires_review, orderCandidate=None)


def deterministic_fallback(plan: EvidencePlan, limits: GroundingLimits) -> AiResponse:
    try:
        validate_plan(plan)
        response = plan.to_response()
        if len(response.reply) <= limits.max_reply_characters:
            return response
    except (ValueError, TypeError, AttributeError):
        pass
    # Broken/unbounded caller plans cannot turn their own draft into a fallback.
    ar = getattr(plan, "language", "en") == "ar"
    return AiResponse(intent=E03Intent.OTHER,
                      reply="مش قادر أتحقق من المعلومات الحالية. ممكن توضح طلبك؟" if ar else
                            "Current information could not be verified. Please clarify your request.",
                      requiresReview=bool(getattr(plan, "requires_review", False)), orderCandidate=None)
