"""Relative comparison of two current verified variants; never a catalog claim."""
from dataclasses import dataclass
from decimal import Decimal, localcontext
from uuid import UUID
from ..data.options import canonical_option_pair


@dataclass(frozen=True)
class PriceComparison:
    lower_id: UUID
    higher_id: UUID
    difference: Decimal
    currency: str


def compare_verified_pair(plan):
    if not plan.comparison or plan.comparison_metric != "price" or len(plan.comparison_alternatives) != 1:
        return None
    key, values = plan.comparison_alternatives[0]
    expected = {canonical_option_pair(key,value) for value in values}
    if len(expected) != 2:
        return None
    variants = [v for v in plan.variants if v.variant_id in plan.matching_variant_ids
                and v.active and v.parent_active and v.options_verified]
    if (len(variants) != 2 or len(plan.products) != 1 or not plan.products[0].active
            or variants[0].product_id != variants[1].product_id
            or any(v.effective_price is None for v in variants)
            or variants[0].currency != variants[1].currency):
        return None
    # Two matches are insufficient if both represent only one requested color,
    # e.g. duplicate variants or two sizes while the other color is missing.
    observed = [{canonical_option_pair(k,value) for k,value in v.option_values} & expected for v in variants]
    if any(len(item) != 1 for item in observed) or set.union(*observed) != expected:
        return None
    lower,higher = sorted(variants,key=lambda v:v.effective_price)
    with localcontext() as context:
        context.prec = 28  # comfortably exact for validated Decimal(12,2) prices
        difference = higher.effective_price - lower.effective_price
    return PriceComparison(lower.variant_id,higher.variant_id,difference,lower.currency)
