"""Conservative dynamic-option matching, shared by retrieval and evidence planning.

Declared values constrain requests; only actual variant records establish a
combination. Arbitrary option names/values use exact normalized matching.
"""
from dataclasses import dataclass, field
import re
from typing import Mapping

from ..nlu import extract_entities, norm_color, norm_size, norm_token, normalize
from ..schemas.backend import Product, ProductVariant

_COLOR = frozenset(normalize(k) for k in ("color", "colour", "colors", "colours", "لون", "اللون", "الوان", "الألوان"))
_SIZE = frozenset(normalize(k) for k in ("size", "sizes", "مقاس", "المقاس", "مقاسات"))


def _kind(key):
    normalized = normalize(key)
    return "color" if normalized in _COLOR else "size" if normalized in _SIZE else normalized


def _value(key, value):
    kind = _kind(key)
    return norm_color(value) if kind == "color" else norm_size(value) if kind == "size" else normalize(value)


def _mentioned(text, phrase):
    return bool(phrase and re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", text))


@dataclass(frozen=True)
class OptionSelection:
    values: tuple[tuple[str, str], ...] = field(default=(), repr=False)
    unresolved: tuple[str, ...] = field(default=(), repr=False)
    alternatives: tuple[tuple[str, tuple[str, ...]], ...] = field(default=(), repr=False)


def resolve_options(product: Product, text: str, explicit: Mapping[str, str] | None = None,
                    alternatives: Mapping[str, tuple[str, ...]] | None = None) -> OptionSelection:
    entities = extract_entities(text)
    normalized = normalize(text)
    selected, unresolved = {}, []
    choices = {}
    for requested_key, values in (alternatives or {}).items():
        for value in values:
            resolved = resolve_options(product, "", {requested_key: value})
            if resolved.unresolved or len(resolved.values) != 1:
                unresolved.append(requested_key)
                continue
            key, canonical = resolved.values[0]
            choices.setdefault(key, []).append(canonical)
    unresolved.extend(key for key, values in choices.items() if len(set(values)) < 2)

    def assign(request_key, requested):
        exact = [key for key in product.options if normalize(key) == normalize(request_key)]
        keys = exact or [key for key in product.options if _kind(key) == _kind(request_key)]
        if len(keys) != 1:
            unresolved.append(request_key)
            return
        key = keys[0]
        if key in choices:
            # Alternatives, not an accidental first color entity, define this
            # option's OR predicate. Unknown contradictory input still fails.
            if not any(_value(key, v) == _value(key, requested) for v in choices[key]):
                unresolved.append(key)
            return
        values = [v for v in product.options[key] if _value(key, v) == _value(key, requested)]
        if len(values) != 1 or (key in selected and selected[key] != values[0]):
            unresolved.append(key)
        else:
            selected[key] = values[0]

    for key, value in (explicit or {}).items():
        assign(key, value)
    for key in product.options:
        labeled = re.search(r"(?<!\w)" + re.escape(norm_token(key)) + r"\s*[:=]\s*([^,;?؟\n]+)", norm_token(text))
        if labeled:
            assign(key, labeled.group(1).strip())
    if entities.color:
        keys = [key for key in product.options if _kind(key) == "color"]
        if len(keys) > 1:
            unresolved.extend(keys)
        elif keys or not any(normalize(value) == normalize(entities.raw_color or entities.color)
                             for values in product.options.values() for value in values):
            assign("color", entities.raw_color or entities.color)
    if entities.size:
        keys = [key for key in product.options if _kind(key) == "size"]
        if len(keys) > 1:
            unresolved.extend(keys)
        elif keys or not any(normalize(value) == normalize(entities.size)
                             for values in product.options.values() for value in values):
            assign("size", entities.size)
    # Detect arbitrary declared values, without fuzzy synonyms or translation.
    mentions = {}
    for key, values in product.options.items():
        for value in values:
            if _mentioned(normalized, normalize(value)):
                mentions.setdefault(normalize(value), []).append((key, value))
    for phrase, occurrences in mentions.items():
        labeled = [(key, value) for key, value in occurrences if re.search(
            r"(?<!\w)" + re.escape(normalize(key)) + r"\s*[:=]?\s+" + re.escape(phrase) + r"(?!\w)", normalized)]
        occurrences_to_assign = labeled or occurrences
        if len(occurrences_to_assign) == 1:
            assign(*occurrences_to_assign[0])
        elif not any(key in selected for key, _ in occurrences_to_assign):
            unresolved.extend(key for key, _ in occurrences_to_assign)
    return OptionSelection(tuple(selected.items()), tuple(dict.fromkeys(unresolved)),
                           tuple((k, tuple(dict.fromkeys(v))) for k, v in choices.items()))


def canonical_option_pair(key: str, value: str) -> tuple[str, str]:
    """Use the same option aliases for matching and derived comparisons."""
    return _kind(key), _value(key, value)


def variant_options_valid(product: Product, variant: ProductVariant) -> bool:
    """Missing/ambiguous option metadata cannot establish a verified combination."""
    expected = {normalize(key): key for key in product.options}
    actual = {normalize(key): key for key in variant.optionValues}
    if len(expected) != len(product.options) or len(actual) != len(variant.optionValues) or expected.keys() != actual.keys():
        return False
    return all(any(_value(expected[key], value) == _value(expected[key], variant.optionValues[actual[key]])
                   for value in product.options[expected[key]]) for key in expected)


def variant_matches_options(product: Product, variant: ProductVariant, selection: OptionSelection) -> bool:
    if selection.unresolved or not variant_options_valid(product, variant):
        return False
    values = {normalize(key): value for key, value in variant.optionValues.items()}
    return (all(_value(key, values[normalize(key)]) == _value(key, requested) for key, requested in selection.values)
        and all(any(_value(key, values[normalize(key)]) == _value(key, requested) for requested in allowed)
                for key, allowed in selection.alternatives))
