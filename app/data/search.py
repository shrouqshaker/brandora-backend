"""Standalone product-search terms, separated from conversational intent text.

Reuse legacy token aliases/Arabic article normalization without changing v1 NLU
or loosening its matcher threshold. Comparison/question language is not a name.
"""
import re

from ..nlu import extract_entities, normalize, color_of, SYN


_FILLER = frozenset(normalize("""
products product show catalog catalogue قصدي اقصد المقصود قارن مقارنه انا محتار محتاره بين
انهي ايهما واحد ارخص اغلي اوفر افضل احسن بس مش عارف عارفه السعر فرق الفرق
compare comparison cheaper cheapest expensive less more difference versus vs better prefer
torn between about actually please tell goes both الاتنين طب رايي غيرت بدل
quantity كميه pale
ana me7tar ben wel anhi a7san arkhas ar5as far2 se3r
3andkom 3ayez 3ayza bekam etneen meno
""").split())
_LEXICAL = {"cotton":"قطن"}  # matching alias only; never a material claim
_FRANCO = {"eswed":"Black", "aswed":"Black", "abyad":"White", "azra2":"Blue"}


def search_terms(text):
    terms = []
    for token in extract_entities(text).product_tokens:
        word, key = normalize(token.orig), token.key
        unjoined = word[1:] if word.startswith("و") else word
        if word in _FILLER or key in _FILLER or unjoined in _FILLER:
            continue
        if word != unjoined and not extract_entities(unjoined).product_tokens:
            continue
        if color_of(normalize(_FRANCO.get(unjoined,unjoined))) is not None:
            continue
        key = _LEXICAL.get(key,key)
        if key not in terms:
            terms.append(key)
    return tuple(terms)


def canonical_search(text):
    return " ".join(search_terms(text))[:160]


def product_anchors(text):
    return frozenset(search_terms(text)) & frozenset(SYN.values())


def mentioned_colors(text):
    colors = []
    for word in normalize(text).split():
        word = word[1:] if word.startswith("و") else word
        color = color_of(normalize(_FRANCO.get(word,word)))
        if color is not None and color not in colors:
            colors.append(color)
    return tuple(colors)


def is_price_comparison(text):
    words = {w[2:] if w.startswith("ال") else w for w in normalize(text).split()}
    return bool(words & {"ارخص","اغلي","اوفر","cheaper","cheapest","expensive","difference","arkhas","ar5as","far2"}
                or "فرق السعر" in normalize(text))


def selection_text(text):
    """Remove only an explicitly superseded known option, never a product noun.

    Works on either side of a correction: White instead of Black, or instead
    of Black I want a cap. The original message still goes to understanding.
    """
    value=normalize(text)
    cue=r"(?:بدلا من|بدل|instead of|rather than)"
    def old_size(match):
        return " " if extract_entities(match.group()).size else match.group()
    value=re.sub(r"(?<!\w)"+cue+r"\s+(?:مقاس|size)\s+\S+",old_size,value)
    def old_color(match):
        return " " if color_of(normalize(match.group(1))) is not None else match.group()
    return re.sub(r"(?<!\w)"+cue+r"\s+(?:(?:اللون|لون|color|colour)\s+)?(\S+)",old_color,value)
