"""Disabled, data-only seam for a future Backend-owned order workflow.

No order client, handler, dispatch, configuration switch or inventory operation
exists here. A handoff is customer intent, never an authorized order command.
"""
from dataclasses import dataclass, field, replace
from typing import Literal

from ..schemas.response import E03Intent
from .evidence_planner import CandidateReference, EvidencePlan, Resolution


@dataclass(frozen=True)
class ProvisionalPurchaseIntent:
    references: tuple[CandidateReference, ...] = field(repr=False)
    requested_quantity: int | None = field(repr=False)
    requested_options: tuple[tuple[str, str], ...] = field(default=(), repr=False)
    missing_selections: tuple[str, ...] = ()
    confirmation_required: bool = True


@dataclass(frozen=True)
class DisabledOrderExtension:
    enabled: Literal[False] = field(default=False, init=False)
    purchase_intent: ProvisionalPurchaseIntent | None = field(default=None, repr=False)


def reserve_order_extension(plan: EvidencePlan, requested_options=None) -> DisabledOrderExtension:
    """Retain minimal intent metadata without executing or enabling anything.

    Even references checked by current read-only retrieval require new authorized,
    transaction-time Backend validation for any eventual order operation.
    """
    if plan.intent != E03Intent.PURCHASE_INTENT or plan.resolution in {
            Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH, Resolution.INVALID,
            Resolution.UNAVAILABLE, Resolution.UNSUPPORTED} or "retrieval_inquiry_mismatch" in plan.limitations:
        return DisabledOrderExtension()
    references = list(plan.references)
    references.extend(CandidateReference(v.product_id, v.variant_id, "planning", False)
                      for v in plan.variants if v.variant_id in plan.matching_variant_ids)
    unique = {}
    for reference in references:
        key = (reference.product_id, reference.variant_id)
        unique.setdefault(key, replace(reference, revalidated=False))
    missing = list(plan.missing_facts) + list(plan.ambiguities)
    if not plan.matching_variant_ids or len(plan.matching_variant_ids) != 1:
        missing.append("unique_variant")
    if plan.requested_quantity is None:
        missing.append("quantity")
    return DisabledOrderExtension(ProvisionalPurchaseIntent(
        tuple(unique.values()), plan.requested_quantity, tuple((requested_options or {}).items()),
        tuple(dict.fromkeys(missing))))
