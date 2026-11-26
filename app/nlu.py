"""Egyptian-Arabic NLU helpers (no network, no model).

Used for three things:
  1. Product matching (typo tolerant) for every request, regardless of who classified the intent.
  2. Entity extraction (quantity / colour / size / time) as a safety net next to Gemini.
  3. A complete rule-based intent classifier, used when Gemini is unavailable (and by the tests).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any, Iterable, Mapping, Sequence

from .schemas import FaqTopic, Intent, RouterResult
from .schemas.request import CatalogItem as Product

# --------------------------------------------------------------------------- normalization

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_MARKS = re.compile("[\u064B-\u065F\u0670\u0640]")  # tashkeel + tatweel
_CHARS = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي",
                        "گ": "ك", "پ": "ب", "ڤ": "ف", "چ": "ج"})
_REPEAT = re.compile(r"([^\W\d_])\1{2,}")  # letters only: "شكراااا" -> "شكرا", but 9999 stays
_SPACES = re.compile(r"\s+")


def norm_token(token: str) -> str:
    t = token.translate(_DIGITS).lower()
    t = _MARKS.sub("", t).translate(_CHARS)
    return _REPEAT.sub(r"\1", t)


def normalize(text: str) -> str:
    """Whole-string normalisation (for regexes / FAQ keyword matching)."""
    t = norm_token(text)
    t = re.sub(r"[^\w\s#]", " ", t)
    return _SPACES.sub(" ", t).strip()


_ARABIC_LETTER = re.compile(r"[\u0600-\u06FF]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")


_FRANCO_DIGIT_WORD = re.compile(r"\b[a-z]*[2357-9][a-z]+\b|\b[a-z]+[2357-9]+[a-z]*\b", re.I)   # 3ayez, 7aga, ma3ak
_FRANCO_WORDS = {"ezay", "ezayak", "ezayek", "bekam", "bikam", "kam", "shokran", "ahlan", "salam", "aywa", "ayowa",
                 "mesh", "msh", "fein", "fen", "enta", "enti", "momken", "tamam", "ya", "eh", "ehh", "law", "samaht"}


def detect_language(text: str, fallback: str = "ar") -> str:
    """'ar' for Arabic script OR Franco-Arabic ("3ayez tshirt"); 'en' for other Latin text; else `fallback`."""
    if _ARABIC_LETTER.search(text or ""):
        return "ar"
    if _LATIN_LETTER.search(text or ""):
        words = re.findall(r"[a-z0-9]+", (text or "").lower())
        if _FRANCO_DIGIT_WORD.search(text or "") or sum(w in _FRANCO_WORDS for w in words) >= 1:
            return "ar"
        return "en"
    return fallback


# --------------------------------------------------------------------------- vocabulary

# multi-word -> single canonical token (applied on normalised token sequences)
PHRASES: dict[tuple[str, ...], str] = {
    ("تي", "شيرت"): "تيشيرت", ("t", "shirt"): "تيشيرت", ("tee", "shirt"): "تيشيرت", ("t", "shirts"): "تيشيرت", ("tee", "shirts"): "تيشيرت",
    ("ميك", "اب"): "ميكاب", ("make", "up"): "ميكاب",
    ("ساعه", "ذكيه"): "سمارتواتش", ("smart", "watch"): "سمارتواتش",
    ("مياه", "غازيه"): "مشروب_غازي", ("مشروب", "غازي"): "مشروب_غازي",
    ("ام", "علي"): "ام_علي", ("اكس", "اكس", "لارج"): "xxl", ("اكس", "لارج"): "xl",
    ("اكسترا", "لارج"): "xl", ("اكس", "سمول"): "xs",
    ("قص", "شعر"): "قص", ("تنظيف", "بشره"): "تنظيف_بشره",
}

_SYN_GROUPS = {
    "تيشيرت": "تيشيرت تيشيرتات تشرت تيشرت تشيرت تشرتات تيشرتات tshirt tshirts tee",
    "هودي": "هودي هوديز هودى هوديات hoodie hoodies سويتشيرت",
    "بنطلون": "بنطلون بنطال بناطيل بناطل بنطلونات pants pant trousers",
    "جينز": "جينز جنز جينس jeans jean",
    "جاكيت": "جاكيت جاكت جاكيتات jacket jackets",
    "فستان": "فستان فساتين dress dresses",
    "حذاء": "حذاء احذيه جزمه جزم كوتشي كوتش shoes shoe",
    "سنيكرز": "سنيكرز سنيكر sneakers sneaker",
    "حزام": "حزام احزمه بيلت belt",
    "شنطه": "شنطه شنط حقيبه bag bags backpack",
    "محفظه": "محفظه محافظ wallet",
    "سماعه": "سماعه سماعات ايربودز earbuds headphones airpods",
    "شاحن": "شاحن شواحن charger",
    "سمارتواتش": "سمارتواتش smartwatch",
    "كاب": "كاب cap قبعه",
    "كشري": "كشري كشرى koshari koshary",
    "فراخ": "فراخ فرخه فرخ دجاج chicken",
    "كباب": "كباب kebab",
    "برجر": "برجر همبرجر برغر burger",
    "شاورما": "شاورما shawarma شورما",
    "بيتزا": "بيتزا بيتزه pizza",
    "عصير": "عصير عصاير juice",
    "قهوه": "قهوه coffee نسكافيه",
    "كنافه": "كنافه kunafa",
    "قص": "قص قصه حلاقه haircut",
    "سشوار": "سشوار بلودراي blowdry",
    "صبغه": "صبغه صبغات dye",
    "كيراتين": "كيراتين keratin",
    "مانيكير": "مانيكير manicure",
    "باديكير": "باديكير pedicure",
    "ميكاب": "ميكاب ميكب makeup",
    "عروسه": "عروسه عرايس bride",
    "مشروب_غازي": "مشروب_غازي بيبسي كولا سبرايت",
}
SYN: dict[str, str] = {w: canon for canon, words in _SYN_GROUPS.items() for w in words.split()}

_COLOR_GROUPS = {
    "اسود": "اسود سوده سودا سوداء black بلاك", "ابيض": "ابيض بيضا بيضه white وايت",
    "احمر": "احمر حمرا حمره red", "ازرق": "ازرق زرقا زرقه blue", "اخضر": "اخضر خضرا خضره green",
    "رمادي": "رمادي رمادى جراي grey gray", "كحلي": "كحلي كحلى نيفي navy", "بيج": "بيج beige",
    "بني": "بني بنى بروان brown", "وردي": "وردي وردى بينك pink", "اصفر": "اصفر صفرا yellow",
    "برتقالي": "برتقالي orange", "بنفسجي": "بنفسجي purple", "زيتي": "زيتي زيتى olive",
    "دهبي": "دهبي ذهبي gold", "فضي": "فضي silver", "عنابي": "عنابي",
}
COLOR_MAP = {w: k for k, words in _COLOR_GROUPS.items() for w in words.split()}
COLOR_DISPLAY = {"اسود": "أسود", "ابيض": "أبيض", "احمر": "أحمر", "ازرق": "أزرق", "اخضر": "أخضر",
                 "رمادي": "رمادي", "كحلي": "كحلي", "بيج": "بيج", "بني": "بني", "وردي": "وردي",
                 "اصفر": "أصفر", "برتقالي": "برتقالي", "بنفسجي": "بنفسجي", "زيتي": "زيتي",
                 "دهبي": "دهبي", "فضي": "فضي", "عنابي": "عنابي"}

SIZE_TOKENS = {"xs", "s", "m", "l", "xl", "xxl", "2xl", "xxxl", "3xl", "4xl"}
SIZE_WORDS = {"لارج": "l", "large": "l", "ميديم": "m", "medium": "m", "سمول": "s", "small": "s"}
SIZE_MARKERS = {"مقاس", "مقاسي", "سايز", "size", "مقاسه"}

COUNT_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "واحد": 1, "واحده": 1, "وحده": 1, "اتنين": 2, "اثنين": 2, "اتنتين": 2, "زوج": 2, "جوز": 2,
    "تلاته": 3, "ثلاثه": 3, "تلات": 3, "اربعه": 4, "اربع": 4, "خمسه": 5, "خمس": 5, "سته": 6,
    "ست": 6, "سبعه": 7, "تمانيه": 8, "ثمانيه": 8, "تسعه": 9, "عشره": 10,
}
PERIOD_WORDS = {"الصبح", "صباحا", "صبح", "الضهر", "ضهرا", "العصر", "عصرا", "المغرب", "بالليل", "ليلا",
                "مساء", "مساءا", "م", "ص", "pm", "am"}
DAY_WORDS = {"النهارده", "انهارده", "النهرده", "بكره", "بكرا", "بعد_بكره", "السبت", "الاحد", "الاثنين",
             "التلات", "الثلاثاء", "الاربع", "الاربعاء", "الخميس", "الجمعه"}

# words that never describe a product
STOP_WORDS = set("""
انا انت احنا هو هي ده دي دا دول ايه ايش اي ليه ازاي فين امتي مين كام كم هل لو لما علشان عشان بس كمان برضو
من في فى علي الي ل ب و مع عن يا يعني طيب تمام اوكي ok اه ايوه لا ده دلوقتي النهارده
عندكم عندك عندكو فيه موجود متاح متوفر بكام بكم سعر اسعار تمن ثمن
مقاس سايز لون قطعه قطع حته حتت واحد واحده وحده
لو سمحت ممكن لي ليا ليكم لينا انتو حضرتك حضرتكم جدا قوي اوي كده كدا
السلام عليكم سلام اهلا هلا مرحبا شكرا
اللي الي اللى عندنا عنده معاكم معاك
خليها خليه خلي خليهم غيرها غيره
حاجه حاجات منتج منتجات شي شيء something anything stuff things item items
i a an the do does you your have has is are there any please pls can could would like to of for me my in on at and or with
what how much it this that some get buy order size color colour price cost available stock hi hello hey thanks thank
want need up where when which who why what whats ll ve re d m s t take taking purchase ordering many pieces piece pcs item items yes yeah no ok okay sure im ill i'll
""".split())
VERB_STEMS = ("عايز", "عاوز", "عوز", "محتاج", "نفسي", "اطلب", "هطلب", "نطلب", "هاخد", "اخد", "خدلي", "اشتري",
              "هشتري", "احجز", "هحجز", "حجز", "اوردر", "ابغي", "اريد", "بتبيع", "بتقدم", "اشوف", "شوف",
              "ابعتلي", "جهزلي", "سجلي", "ضيفلي",
              # change / cancel verbs are never a product name
              "اغير", "اعدل", "نغير", "نعدل", "غير", "عدل", "تغيير", "تعديل", "الغي", "كنسل")

NOUN_STEMS = {"تيشيرت", "هودي", "بنطلون", "جاكيت", "حزام", "فستان", "كاب", "برجر", "عصير", "جينز"}



# --------------------------------------------------------------------------- budget ceiling ("تحت 200", "under 300")

# (marker words, weak?). A weak marker ("لحد", "up to") is only trusted with a currency word or a number >= 50.
MAX_PRICE_MARKERS: list[tuple[tuple[str, ...], bool]] = sorted([
    (("تحت",), False), (("اقل", "من"), False), (("ارخص", "من"), False), (("في", "حدود"), False), (("حدود",), False),
    (("ميزانيتي",), False), (("مايزيدش", "عن"), False), (("ميزيدش", "عن"), False), (("ماتزيدش", "عن"), False),
    (("حد", "اقصي"), False), (("اقصي", "سعر"), False), (("بحد", "اقصي"), False),
    (("under",), False), (("below",), False), (("less", "than"), False), (("cheaper", "than"), False),
    (("no", "more", "than"), False), (("not", "more", "than"), False), (("budget",), False), (("max", "price"), False),
    (("لحد",), True), (("up", "to"), True), (("max",), True), (("maximum",), True), (("within",), True),
], key=lambda m: -len(m[0]))
PRICE_NUMBER_WORDS = {"ميه": 100, "ميتين": 200, "تلتميه": 300, "تلاتميه": 300, "اربعميه": 400, "ربعميه": 400,
                      "خمسميه": 500, "ستميه": 600, "سبعميه": 700, "تمنميه": 800, "تمانميه": 800, "تسعميه": 900,
                      "الف": 1000, "الفين": 2000}
CURRENCY_WORDS = {"جنيه", "جنية", "جنيهات", "ج", "egp", "le", "pound", "pounds"}
PRICE_FILLER = {"حوالي", "تقريبا", "about", "around", "حد", "الي"}


# --------------------------------------------------------------------------- tokens


@dataclass
class Token:
    orig: str
    norm: str
    key: str  # canonical form used for matching


def _variants(tok: str) -> Iterable[str]:
    yield tok
    if tok.startswith("وال") and len(tok) > 4:
        yield tok[3:]
    if tok.startswith("بال") and len(tok) > 4:
        yield tok[3:]
    if tok.startswith("لل") and len(tok) > 4:
        yield "ال" + tok[2:]
        yield tok[2:]
    if tok.startswith("ال") and len(tok) > 3:
        yield tok[2:]
    if tok.startswith("و") and len(tok) > 3:
        yield tok[1:]
    if tok.startswith("ب") and len(tok) > 3:
        yield tok[1:]


def canon_token(tok: str) -> str:
    for v in _variants(tok):
        if v in SYN:
            return SYN[v]
    return tok[2:] if tok.startswith("ال") and len(tok) > 3 else tok


def color_of(tok: str) -> str | None:
    for v in _variants(tok):
        if v in COLOR_MAP:
            return COLOR_MAP[v]
    return None


def norm_color(value: str | None) -> str | None:
    """"الاسود" / "Black" / "أسود" -> "اسود" (the canonical key); unknown words are returned normalised."""
    if not value:
        return None
    n = normalize(value)
    return color_of(n) or n


def norm_size(value: str | int | None) -> str | None:
    if value is None:
        return None
    n = normalize(str(value)).replace(" ", "")
    n = SIZE_WORDS.get(n, n).upper()
    return {"2XL": "XXL", "3XL": "XXXL"}.get(n, n)


def tokenize(text: str) -> list[Token]:
    raw = re.findall(r"[\w#]+", text.translate(_DIGITS))
    norms = [norm_token(t) for t in raw]
    out: list[Token] = []
    i = 0
    while i < len(raw):
        merged = False
        for n in (3, 2):
            seq = tuple(norms[i:i + n])
            if len(seq) == n and seq in PHRASES:
                canon = PHRASES[seq]
                out.append(Token(" ".join(raw[i:i + n]), canon, canon))
                i += n
                merged = True
                break
        if merged:
            continue
        out.append(Token(raw[i], norms[i], canon_token(norms[i])))
        i += 1
    return out


def tok_match(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) < 4 or len(b) < 4:
        return False
    if a.startswith(b) or b.startswith(a):
        return min(len(a), len(b)) >= 4
    return SequenceMatcher(None, a, b).ratio() >= 0.82


# --------------------------------------------------------------------------- entity extraction


@dataclass
class Entities:
    quantity: int | None = None
    color: str | None = None        # normalised key, e.g. "اسود"
    raw_color: str | None = None    # the word the customer actually typed ("black", "الاسود")
    size: str | None = None         # e.g. "L", "XL", "34"
    time_phrase: str | None = None
    order_ref: str | None = None
    max_price: Decimal | None = None   # budget ceiling in EGP ("تحت 200 جنيه")
    product_tokens: list[Token] = field(default_factory=list)
    has_slot_data: bool = False


def _is_function_word(tok: Token) -> bool:
    if tok.key in STOP_WORDS or tok.norm in STOP_WORDS or tok.norm in _CONFIRM_WORDS:
        return True
    return any(tok.norm.startswith(stem) for stem in VERB_STEMS)



def _price_value(norm: str) -> int | None:
    if norm.isdigit() and len(norm) <= 7:
        return int(norm)
    return PRICE_NUMBER_WORDS.get(norm)


def _extract_max_price(tokens: list[Token], consumed: set[int]) -> Decimal | None:
    """Find "<marker> <number> [currency]" and mark the tokens as used so they never become a product term/quantity."""
    n, i = len(tokens), 0
    while i < n:
        if i in consumed:
            i += 1
            continue
        for words, weak in MAX_PRICE_MARKERS:
            if tuple(t.norm for t in tokens[i:i + len(words)]) != words:
                continue
            j = i + len(words)
            while j < n and tokens[j].norm in PRICE_FILLER:
                j += 1
            value = _price_value(tokens[j].norm) if j < n else None
            if value is None:
                continue
            end = j + 1
            has_currency = end < n and tokens[end].norm in CURRENCY_WORDS
            if weak and not has_currency and value < 50:
                continue
            consumed.update(range(i, end + (1 if has_currency else 0)))
            return Decimal(value)
        i += 1
    return None


def extract_entities(text: str) -> Entities:
    tokens = tokenize(text)
    ent = Entities()
    consumed: set[int] = set()
    n = len(tokens)

    m = re.search(r"(?:#|رقم|طلب(?:ي|يه|يتي)?|اوردر(?:ي)?|order)\s*#?\s*(?:br-?)?(\d{3,6})\b",
                  normalize(text).replace("# ", "#"))
    if m:
        ent.order_ref = m.group(1)

    # time phrases (bookings): "الساعة 5 العصر", "بكره", "الجمعة"
    days: list[str] = []
    hour_txt: str | None = None
    for i, tok in enumerate(tokens):
        if i in consumed:
            continue
        if tok.norm in ("ساعه", "الساعه") and i + 1 < n and tokens[i + 1].norm.isdigit():
            hour = tokens[i + 1].norm
            period = ""
            consumed.update({i, i + 1})
            if i + 2 < n and tokens[i + 2].norm in PERIOD_WORDS:
                period = " " + tokens[i + 2].orig
                consumed.add(i + 2)
            hour_txt = f"الساعة {hour}{period}"
        elif tok.norm.isdigit() and i + 1 < n and tokens[i + 1].norm in PERIOD_WORDS and int(tok.norm) <= 12:
            hour_txt = f"{tok.norm} {tokens[i + 1].orig}"
            consumed.update({i, i + 1})
        if tok.norm in DAY_WORDS or tok.key in DAY_WORDS:
            days.append(tok.orig)
            consumed.add(i)
    after = next((k for k in range(n - 1) if tokens[k].norm == "بعد" and tokens[k + 1].norm in ("بكره", "بكرا")), None)
    if after is not None:
        days = [d for d in days if norm_token(d) not in ("بكره", "بكرا")] + ["بعد بكرة"]
        consumed.update({after, after + 1})
    if days or hour_txt:
        ent.time_phrase = " ".join(days + ([hour_txt] if hour_txt else []))

    ent.max_price = _extract_max_price(tokens, consumed)   # before sizes/quantity, so "تحت 200" is not read as one

    # size marker + value, colours, standalone sizes
    for i, tok in enumerate(tokens):
        if i in consumed:
            continue
        if tok.norm in SIZE_MARKERS and i + 1 < n:
            nxt = tokens[i + 1]
            if nxt.norm in SIZE_TOKENS or nxt.norm in SIZE_WORDS or nxt.norm.isdigit():
                ent.size = norm_size(nxt.norm)
                consumed.update({i, i + 1})
                continue
        c = color_of(tok.norm)
        if c and ent.color is None:
            ent.color = c
            ent.raw_color = tok.orig
            consumed.add(i)
        elif tok.norm in SIZE_TOKENS or tok.norm in SIZE_WORDS:
            if ent.size is None:
                ent.size = norm_size(tok.norm)
            consumed.add(i)

    # quantity
    for i, tok in enumerate(tokens):
        if i in consumed:
            continue
        if tok.norm.endswith("ين") and tok.norm[:-2] in NOUN_STEMS:
            ent.quantity = ent.quantity or 2
            tok.key = canon_token(tok.norm[:-2])
            continue
        if tok.norm in COUNT_WORDS:
            ent.quantity = ent.quantity or COUNT_WORDS[tok.norm]
            consumed.add(i)
        elif tok.norm.isdigit():
            value = int(tok.norm)
            prev = tokens[i - 1].norm if i else ""
            if prev in ("رقم", "#"):
                continue
            if value <= 20:
                ent.quantity = ent.quantity or value
                consumed.add(i)
            elif 25 <= value <= 60 and ent.size is None:
                ent.size = str(value)
                consumed.add(i)
            elif value > 60 and ent.quantity is None and re.search(r"\b" + tok.norm + r"\s*(قطعه|حته|وحده)", normalize(text)):
                ent.quantity = value
                consumed.add(i)

    ent.product_tokens = [t for i, t in enumerate(tokens)
                          if i not in consumed and not _is_function_word(t) and not t.norm.isdigit()
                          and not t.norm.startswith("#")]
    ent.has_slot_data = any([ent.quantity, ent.color, ent.size, ent.time_phrase])
    return ent


# --------------------------------------------------------------------------- products


def product_token_keys(p: Product) -> set[str]:
    attrs = p.attributes or {}
    parts: list[str] = [p.name, p.category or "", str(attrs.get("material") or "")]
    aliases = attrs.get("aliases")
    if isinstance(aliases, list):
        parts.extend(str(a) for a in aliases)
    keys: set[str] = set()
    for tok in tokenize(" ".join(parts)):
        if tok.key not in STOP_WORDS and color_of(tok.norm) is None:
            keys.add(tok.key)
    return keys


def in_stock(p: Product) -> bool:
    return not (p.trackInventory and (p.stockQuantity or 0) <= 0)


_COLOR_KEYS = {"color", "colour", "colors", "colours", "لون", "الوان", "اللون", "الالوان"}
_SIZE_KEYS = {"size", "sizes", "مقاس", "مقاسات", "المقاس", "المقاسات", "سايز"}
_SPLIT = re.compile(r"\s*[,،/|;]\s*|\s+(?:و|or|and)\s+")
SERVICE_VALUES = {"service", "services", "خدمه", "خدمة"}


def _flat_values(attrs: dict, keys: set[str]) -> list[str]:
    """Owner-defined flat attributes ({"Color": "Black, Gray", "Size": "S/M/L"}) -> ["Black", "Gray"]."""
    out: list[str] = []
    for key, raw in (attrs or {}).items():
        if normalize(str(key)) not in keys or raw is None:
            continue
        for item in (raw if isinstance(raw, list) else [raw]):
            for part in _SPLIT.split(str(item)):
                part = part.strip()
                if part and part not in out:
                    out.append(part)
    return out


def product_colors(p: Product) -> list[str]:
    """Colours the catalog defines for this item: attribute value(s), else colour words inside the name."""
    found = _flat_values(p.attributes or {}, _COLOR_KEYS)
    if found:
        return found
    return [t.orig for t in tokenize(p.name) if color_of(t.norm)][:1]


def product_sizes(p: Product) -> list[str]:
    found = _flat_values(p.attributes or {}, _SIZE_KEYS)
    if found:
        return found
    return [t.orig.upper() for t in tokenize(p.name) if t.norm in SIZE_TOKENS][:1]


def colors_are_a_choice(p: Product) -> bool:
    return len(_flat_values(p.attributes or {}, _COLOR_KEYS)) > 1


def sizes_are_a_choice(p: Product) -> bool:
    return len(_flat_values(p.attributes or {}, _SIZE_KEYS)) > 1


def has_color(p: Product, color_key: str) -> bool:
    return any(norm_color(c) == color_key for c in product_colors(p))


def is_service_item(p: Product) -> bool:
    return any(normalize(str(v)) in SERVICE_VALUES for k, v in (p.attributes or {}).items()
               if normalize(str(k)) in {"type", "نوع"})


def within_budget(p: Product, max_price: Decimal | None) -> bool:
    """No budget -> always true. With a budget an item with an unknown price can't be claimed as "under X", so it is out."""
    return max_price is None or (p.basePrice is not None and p.basePrice <= max_price)


def find_products(term_tokens: list[Token], products: list[Product], max_price: Decimal | None = None) -> list[Product]:
    """Typo-tolerant search. Returns the best-scoring products (ties kept, in-stock first).

    `max_price` removes every product priced above the ceiling (or without a price) before scoring."""
    if not term_tokens:
        return []
    scored: list[tuple[float, int, Product]] = []
    for order, p in enumerate(products):
        if not p.isActive or not within_budget(p, max_price):
            continue
        keys = product_token_keys(p)
        hit = sum(1 for t in term_tokens if any(tok_match(t.key, k) for k in keys))
        if hit:
            scored.append((hit / len(term_tokens), order, p))
    if not scored:
        return []
    top = max(s for s, _, _ in scored)
    kept = [(s, o, p) for s, o, p in scored if s >= max(0.5, top - 0.001)]
    kept.sort(key=lambda x: (-x[0], not in_stock(x[2]), x[1]))
    return [p for _, _, p in kept]


def search_products(text: str, products: list[Product], max_price: Decimal | None = None) -> list[Product]:
    """Search by free text. A budget written in the text ("تيشيرت تحت 200") applies unless `max_price` is given."""
    ent = extract_entities(text)
    return find_products(ent.product_tokens, products, max_price if max_price is not None else ent.max_price)


def budget_products(products: list[Product], max_price: Decimal, limit: int = 6) -> list[Product]:
    """Everything the customer can buy under the ceiling (active, in stock, priced), cheapest first."""
    ok = [p for p in products if p.isActive and in_stock(p) and within_budget(p, max_price)]
    return sorted(ok, key=lambda p: p.basePrice or Decimal(0))[:limit]


# --------------------------------------------------------------------------- intent signals


def _rx(words: Iterable[str], prefix: bool = True, suffix: int = 3) -> re.Pattern[str]:
    alt = "|".join(re.escape(w) for w in words)
    pre = "(?:ال|لل|ب|و|ف|ل)?" if prefix else ""
    return re.compile(rf"(?<!\S){pre}(?:{alt})\S{{0,{suffix}}}(?!\S)")


_SIG = {
    "greeting": _rx(["good morning", "good evening", "good afternoon", "سلام", "اهلا", "اهلين", "هلا", "مرحبا", "مرحبتين", "صباح", "مساء الخير", "هاي", "hi", "hello", "hey"], suffix=2),
    "thanks": _rx(["appreciate", "شكرا", "شكر", "متشكر", "تسلم", "ميرسي", "مرسي", "thanks", "thank", "thx", "يكرمك", "جزاك", "كتر خيرك"]),
    "complaint": _rx(["اتاخر", "تاخر", "تاخير", "متاخر", "وحش", "سيء", "زفت", "زباله", "مش راضي", "غير راضي",
                      "شكوي", "اشتكي", "مشكله", "مشاكل", "غلط", "ناقص", "باظ", "بايظ", "مكسور", "اتكسر", "تالف",
                      "رديء", "نصب", "مش كويس", "مش عاجبني", "استرداد", "رجعوا فلوسي", "محدش كلمني", "محدش رد",
                      "مفيش حد رد"]),
    "order_noun": _rx(["طلب", "طلبي", "طلبيه", "طلبيتي", "اوردر", "اوردري", "حجزي", "حجز"], suffix=1),
    "status_word": _rx(["فين", "وصل", "حاله", "هيوصل", "امتي", "متابعه", "موعد", "وصلش", "مجاش", "موصلش", "لسه"]),
    "follow_phrase": _rx(["امتي هيوصل", "هيوصل امتي", "اتابع طلبي", "where is my order", "order status", "track my order", "when will my order", "when will it arrive", "has my order shipped", "لسه مجاش", "لسه موصلش", "وصل فين", "حاله الطلب", "متابعه الطلب", "فين طلبي", "فين الاوردر"]),
    "order_verb": _rx(["i ll take", "ill take", "i will take", "get me", "give me", "place an order", "i d like to order", "اطلب", "اطلبلي", "هطلب", "نطلب", "هاخد", "اخد", "خدلي", "اشتري", "اشتريلي", "هشتري",
                       "احجز", "احجزلي", "هحجز", "اوردر", "order", "book", "buy", "جهزلي", "سجلي", "ضيفلي"]),
    "price": _rx(["بكام", "بكم", "سعر", "اسعار", "تمن", "ثمن", "price", "cost", "how much"]),
    "want": _rx(["عايز", "عايزه", "عاوز", "عاوزه", "عوز", "عوزه", "محتاج", "محتاجه", "نفسي", "ابغي", "اريد",
                 "want", "need", "looking"]),
    "availability": _rx(["عندكم", "عندك", "عندكو", "متاح", "متوفر", "موجود", "فيه", "available", "have you", "do you have"]),
    "catalog": _rx(["what do you sell", "what do you have", "products", "what s available", "منيو", "menu", "كتالوج", "catalog", "المنتجات", "الاصناف", "الوجبات", "الخدمات", "بتبيعوا",
                    "بتقدموا", "ايه المتاح", "عندكم ايه", "فيه ايه"]),
    # ---- customer-service intents (normalised Arabic: no hamza / tashkeel, ة->ه, ى->ي)
    "help": _rx(["ازاي اطلب", "ازاي ممكن اطلب", "ازاي اقدر اطلب", "ازاي اشتري", "ازاي استخدم", "ازاي اعمل اوردر",
                 "ازاي اعمل طلب", "طريقه الطلب", "طريقه الاستخدام", "طريقه استخدام", "مساعده", "ساعدني", "ساعدوني",
                 "how do i order", "how to order", "how can i order", "how does this work", "how to use", "help me",
                 "need help", "help"], suffix=1),
    "modify_verb": _rx(["اغير", "اعدل", "تغيير", "تعديل", "نغير", "نعدل", "غيرلي", "عدللي", "غير العنوان", "غير الطلب",
                        "عدل الطلب", "اضيف علي الطلب", "اضيف للطلب", "change my", "change the address",
                        "change address", "change the order", "modify", "edit my", "update my", "amend"]),
    "slot_word": _rx(["مقاس", "لون", "كميه", "الكميه", "size", "color", "colour", "quantity"]),
    "existing_order_ref": _rx(["العنوان", "عنوان", "address", "الطلب", "طلبي", "الاوردر", "اوردري", "الحجز", "order"], suffix=1),
    "cancel_verb": _rx(["الغي", "الغيلي", "كنسل", "cancel", "الغاء الطلب", "الغاء الاوردر", "الغاء الحجز"]),
    "returns_policy": _rx(["ازاي ارجع", "ارجع المنتج", "ارجع الطلب", "ارجع الحاجه", "ينفع ارجع", "استرجاع", "استبدال",
                           "ابدل", "تبديل", "سياسه الاسترجاع", "سياسه الاستبدال", "return policy", "how do i return",
                           "how to return", "can i return", "return it", "exchange", "refund"]),
    "paid": _rx(["دفعت", "حولت", "سددت", "paid", "i paid", "transferred"]),
    "no_response": _rx(["محدش", "مفيش حد", "ولسه", "لسه", "مردوش", "مفيش رد", "مجاش", "وصلش", "موصلش", "no response",
                        "nobody", "no one", "not received", "didn t", "still", "never"]),
    "money_lost": _rx(["اتخصم", "اتخصمت", "خصموا", "اتسحب", "اتسحبت", "charged twice", "double charged",
                       "deducted twice", "payment failed", "money was deducted"]),
    "legal_threat": _rx(["هشتكي", "هقدم بلاغ", "هبلغ عنكم", "بلاغ", "نيابه", "محامي", "قانوني", "قضيه", "هقاضيكم",
                         "اقاضيكم", "حمايه المستهلك", "هفضحكم", "شرطه", "legal action", "sue you", "i will sue",
                         "going to sue", "lawyer", "consumer protection", "report you", "police"]),
    "custom_request": _rx(["تصميم خاص", "تصميم مخصوص", "طلب خاص", "طلب مخصوص", "حاجه مخصوصه", "مخصوص", "مخصوصه",
                           "تفصيل", "custom order", "custom design", "custom made", "custom request", "customized",
                           "customised", "bespoke", "personalized", "personalised", "special request", "made to order",
                           "tailor made"]),
}
_FAQ = {
    FaqTopic.DELIVERY: _rx(["deliver", "ship", "توصيل", "توصلوا", "توصل", "دليفري", "ديليفري", "شحن", "بتشحنوا", "delivery", "shipping"]),
    FaqTopic.WORKING_HOURS: _rx(["are you open", "open today", "open now", "business hours", "what time do you", "بتفتحوا", "بتقفلوا", "فاتحين", "مفتوح", "مفتوحين", "ساعات العمل", "مواعيد العمل",
                                 "مواعيدكم", "مواعيدكو", "مواعيد الشغل", "بتشتغلوا", "working hours", "opening hours"], prefix=False),
    FaqTopic.PAYMENT: _rx(["payment", "pay", "card", "cod", "دفع", "ادفع", "كاش", "فيزا", "فودافون كاش", "انستاباي", "instapay", "visa", "cash", "تقسيط"]),
    FaqTopic.RETURNS: _rx(["استرجاع", "استبدال", "ابدل", "تبديل", "ضمان", "ارجع", "exchange", "refund", "return", "الغاء", "return policy"]),
    FaqTopic.LOCATION: _rx(["where are you", "where is the store", "عنوان", "عنوانكم", "مكانكم", "فرعكم", "فروع", "لوكيشن", "location", "address", "فين المحل", "فين الفرع", "فين مكانكم"]),
    FaqTopic.OTHER: _rx(["عروض", "عرض", "خصم", "خصومات", "اوفر", "offer", "offers", "discount", "كوبون", "برومو", "باكدج"]),
    FaqTopic.CONTACT: _rx(["phone number", "call you", "whatsapp number", "رقم تليفون", "رقمكم", "تليفون", "تواصل", "هكلمكم", "contact", "phone", "اتصل"]),
}
_CONFIRM_WORDS = {"yeah", "yep", "confirm", "sure", "correct", "go", "ahead", "ايوه", "ايوا", "اه", "اكيد", "تمام", "ماشي", "اوكي", "اوكيه", "ok", "okay", "yes", "اكد", "اكدي",
                  "اكدلي", "اتفقنا", "موافق", "موافقه", "يلا", "ياريت", "اكده", "الطلب", "الحجز", "كده"}


def _sig_flags(norm: str) -> dict[str, bool]:
    return {name: bool(rx.search(norm)) for name, rx in _SIG.items()}


def is_payment_dispute(sig: Mapping[str, bool]) -> bool:
    """"دفعت ومحدش رد": the customer says they paid AND nothing happened, or money was taken twice / lost."""
    return (sig["paid"] and (sig["no_response"] or sig["complaint"])) or sig["money_lost"]


def is_hostile_text(text: str) -> bool:
    """True for a payment dispute or a legal threat: the customer is upset enough that the owner must handle it."""
    sig = _sig_flags(normalize(text))
    return sig["legal_threat"] or is_payment_dispute(sig)


STRONG_FAQ_SCORE = 3   # two keyword hits, or one keyword + a matching question word
WEAK_FAQ_SCORE = 2


def _content_keys(text: str) -> set[str]:
    return {t.key for t in tokenize(text) if t.key not in STOP_WORDS and t.norm not in STOP_WORDS and len(t.key) > 1}


def match_faq(text: str, faqs: Sequence[Mapping[str, Any]]) -> tuple[int | None, int]:
    """Best owner-written FAQ for a free-form question, typo tolerant: (0-based index, score) or (None, 0).

    A keyword counts 2 when ALL its words appear in the message; every word shared with the FAQ question counts 1; and +2
    when the message contains ALL the content words of the question (so FAQ rows with only `question` + `answer`, no
    keywords, still resolve: "الباقة بكام؟" <- "الباقه بكام")."""
    words = _content_keys(text)
    best_i: int | None = None
    best = 0
    for i, item in enumerate(faqs):
        if not str(item.get("answer") or "").strip():
            continue
        keyword_hits = 0
        for kw in item.get("keywords") or []:
            keys = _content_keys(str(kw))
            if keys and all(any(tok_match(w, k) for w in words) for k in keys):
                keyword_hits += 1
        question_keys = _content_keys(str(item.get("question") or ""))
        overlap = sum(1 for q in question_keys if any(tok_match(w, q) for w in words))
        covered = bool(question_keys) and overlap == len(question_keys)
        score = 2 * keyword_hits + overlap + (2 if covered else 0)
        if score > best:
            best_i, best = i, score
    return best_i, best


def detect_faq_topic(norm_text: str) -> FaqTopic | None:
    for topic, rx in _FAQ.items():
        if rx.search(norm_text):
            return topic
    return None


_STRONG_YES = {"ايوه", "ايوا", "اه", "اكيد", "ماشي", "اوكي", "اوكيه", "ok", "okay", "yes", "yeah", "yep", "confirm",
               "sure", "correct", "اكد", "اكدي", "اكدلي", "اتفقنا", "موافق", "موافقه", "تمام", "يلا"}
# --- cancelling / changing an EXISTING order: the words mean the opposite of an order summary ("الغي" = yes, do it)
_CANCEL_YES = {"الغي", "الغيه", "الغيها", "الغيلي", "كنسل", "cancel", "canceled", "cancelled", "cancellation", "الغاء"}
_MODIFY_YES = {"عدل", "عدلي", "عدله", "غير", "غيره", "غيرلي", "اعدل", "نعدل", "change", "modify", "update", "amend"}
_CANCEL_NO = {"متلغيش", "ماتلغيش", "متلغيهوش", "ماتلغيهوش", "متلغيهاش", "مش", "dont", "don", "never", "keep", "سيبه", "سيبها", "خليه", "خليها"}
_MODIFY_NO = {"متغيرش", "ماتغيرش", "متعدلش", "ماتعدلش", "مش", "dont", "don", "never", "keep", "سيبه", "سيبها", "خليه", "خليها"}
_ACTION_FILLER = {"عايز", "عايزه", "عاوز", "عاوزه", "الطلب", "الاوردر", "الحجز", "فعلا", "please", "it", "the", "my", "order", "t", "s",
                  "خلاص", "لا", "no"}
_ACTIONS = {"cancel": (_CANCEL_YES, _CANCEL_NO), "modify": (_MODIFY_YES, _MODIFY_NO)}


def is_pure_confirmation(text: str, context: str = "order") -> bool:
    """A bare "yes" to what we just asked.

    context="order":  the order summary ("ايوه اكد").
    context="cancel"/"modify": we asked to confirm cancelling/changing an existing order, so "ايوه الغي", "اه عدل",
    "yes cancel" and even "لا خلاص الغي" are a YES; any negation ("متلغيش", "don't cancel", "keep it") is not."""
    toks = normalize(text).split()
    if not toks:
        return False
    if context in _ACTIONS:
        yes_words, no_words = _ACTIONS[context]
        allowed = _CONFIRM_WORDS | yes_words | _ACTION_FILLER
        return (all(t in allowed for t in toks) and any(t in _STRONG_YES or t in yes_words for t in toks)
                and not any(t in no_words for t in toks))
    return all(t in _CONFIRM_WORDS for t in toks) and any(t in _STRONG_YES for t in toks)


@dataclass
class RuleContext:
    """What the deterministic classifier needs to know about the conversation."""

    products: list[Product] = field(default_factory=list)
    mid_order: bool = False                       # our last message asked for an order detail
    awaiting_confirm: bool = False                # our last message was the order summary
    faqs: list[dict[str, Any]] = field(default_factory=list)   # the business's owner-written FAQs (same order as the prompt)


def _service_intents(sig: Mapping[str, bool], editing_pending_order: bool) -> list[Intent]:
    """Escalation and customer-service intents in priority order (empty = none matched).

    `editing_pending_order`: an order summary is open and the customer is changing ITS size/colour/quantity, so a modify
    verb is not about an existing order ("غير المقاس لـ L"), while "عايز أغير العنوان" / "أعدل الطلب" always is."""
    found: list[Intent] = []
    if sig["legal_threat"]:
        found.append(Intent.LEGAL_THREAT)
    if is_payment_dispute(sig):
        found.append(Intent.PAYMENT_DISPUTE)
    if sig["cancel_verb"]:
        found.append(Intent.ORDER_CANCEL)
    if sig["modify_verb"] and not editing_pending_order:
        found.append(Intent.ORDER_MODIFY)
    if sig["custom_request"]:
        found.append(Intent.CUSTOM_REQUEST)
    if sig["returns_policy"]:
        found.append(Intent.RETURNS_POLICY)
    if sig["help"]:
        found.append(Intent.HELP)
    if found and sig["complaint"]:
        found.append(Intent.COMPLAINT)
    return found


def classify_rules(text: str, ctx: RuleContext) -> RouterResult:
    """Deterministic fallback classifier. Returns the same shape Gemini returns."""
    norm = normalize(text)
    ent = extract_entities(text)
    matches = find_products(ent.product_tokens, ctx.products, ent.max_price)
    sig = _sig_flags(norm)
    faq = detect_faq_topic(norm)
    faq_idx, faq_score = match_faq(text, ctx.faqs)
    pending_order = ctx.mid_order or ctx.awaiting_confirm
    # a modify verb while an order is open is an edit of THAT order only when it talks about its size/colour/quantity
    editing_pending = (pending_order and (ent.has_slot_data or sig["slot_word"]) and not sig["existing_order_ref"])

    sig["follow_up"] = sig["follow_phrase"] or (sig["order_noun"] and sig["status_word"] and not sig["order_verb"])
    if sig["complaint"] and sig["follow_up"] and not re.search(r"فين|وصل|حاله", norm):
        sig["follow_up"] = False

    def result(intents: list[Intent], conf: float, topic: FaqTopic | None = faq, faq_number: int | None = None) -> RouterResult:
        color_display = ent.raw_color or (COLOR_DISPLAY.get(ent.color) if ent.color else None)
        return RouterResult(
            intents=intents[:3], confidence=conf, product_query=" ".join(t.orig for t in ent.product_tokens) or None,
            quantity=ent.quantity, color=color_display, size=ent.size, preferred_time=ent.time_phrase,
            order_reference=ent.order_ref, faq_topic=topic, faq_id=faq_number,
            max_price=float(ent.max_price) if ent.max_price is not None else None)

    # 1) escalation / customer-service intents win over everything else
    service = _service_intents(sig, editing_pending)
    if service:
        return result(service, 0.9, topic=None)

    wants_something = sig["want"] or sig["availability"] or sig["catalog"]
    product_ish = bool(matches) or bool(ent.product_tokens and wants_something)
    order_like = sig["order_verb"] and (bool(matches) or ent.has_slot_data or bool(ent.product_tokens) or ctx.mid_order)
    if not order_like and matches and ent.quantity and not sig["price"] and not sig["availability"] and not sig["catalog"]:
        order_like = True
    inquiry_like = sig["price"] or sig["want"] or sig["availability"] or sig["catalog"]
    faq_strong = faq_idx is not None and faq_score >= STRONG_FAQ_SCORE   # "اللمبة الحمرا": "الحمرا" is not a colour answer
    if (not order_like and ctx.mid_order and (ent.has_slot_data or matches)
            and not (inquiry_like or sig["complaint"] or sig["follow_up"] or faq or faq_strong or sig["greeting"]
                     or sig["thanks"])):
        order_like = True  # short answer to the question we just asked ("الاسود L اتنين")
    if sig["modify_verb"] and editing_pending:
        order_like = True  # "غير المقاس" with an open summary: handled as an edit of that order

    intents: list[Intent] = []
    conf = 0.85
    if sig["complaint"]:
        intents.append(Intent.COMPLAINT)
    if sig["follow_up"]:
        intents.append(Intent.ORDER_STATUS)
    if order_like:
        intents.append(Intent.CREATE_ORDER)
    if faq and not (matches and (sig["price"] or sig["order_verb"])):
        intents.append(Intent.GENERAL_INFO)
    if sig["price"]:
        intents.append(Intent.PRICE_INQUIRY)
    if (product_ish or sig["catalog"] or sig["availability"] or ent.max_price is not None) and not order_like:
        intents.append(Intent.PRODUCT_INQUIRY)   # a bare budget ("ميزانيتي ميتين") is a request to see what fits it
    if not intents:
        if sig["greeting"]:
            intents.append(Intent.GREETING)
        elif sig["thanks"]:
            intents.append(Intent.THANKYOU)
    else:
        if sig["greeting"] and len(norm.split()) <= 2:
            intents.insert(0, Intent.GREETING)

    # 2) a question the owner answered in their FAQ ("الباقة بكام؟", "اللمبة الحمرا معلقة") is GENERAL_INFO, unless the
    #    customer is clearly buying/complaining/asking about an order or a catalog product
    faq_number: int | None = None
    if faq_idx is not None and faq_score >= WEAK_FAQ_SCORE:
        busy = {Intent.CREATE_ORDER, Intent.COMPLAINT, Intent.ORDER_STATUS} & set(intents)
        beats_product = faq_score >= STRONG_FAQ_SCORE and (not matches or faq_score >= 5)
        if not busy and (beats_product or not intents):
            intents = [Intent.GENERAL_INFO] + [i for i in intents if i not in (
                Intent.GENERAL_INFO, Intent.PRODUCT_INQUIRY, Intent.PRICE_INQUIRY)]
            faq_number = faq_idx + 1
            faq = faq or FaqTopic.OTHER

    # PRICE + product phrasing ("عايز تيشيرت بكام") -> PRODUCT_INQUIRY primary, PRICE secondary; bare price -> PRICE primary
    if Intent.PRICE_INQUIRY in intents and Intent.PRODUCT_INQUIRY in intents:
        intents = [i for i in intents if i not in (Intent.PRICE_INQUIRY, Intent.PRODUCT_INQUIRY)]
        if sig["want"] or sig["availability"]:
            intents += [Intent.PRODUCT_INQUIRY, Intent.PRICE_INQUIRY]
        else:
            intents += [Intent.PRICE_INQUIRY, Intent.PRODUCT_INQUIRY]
    if Intent.PRICE_INQUIRY in intents and Intent.CREATE_ORDER in intents:
        intents = [Intent.CREATE_ORDER] + [i for i in intents if i != Intent.CREATE_ORDER]

    # priority order for the primary intent
    head_set = (Intent.COMPLAINT, Intent.ORDER_STATUS, Intent.CREATE_ORDER, Intent.GENERAL_INFO)
    if intents:
        head = [i for i in head_set if i in intents]
        intents = head + [i for i in intents if i not in head]
    else:
        intents = [Intent.UNKNOWN]
        conf = 0.3
    if intents[0] in (Intent.PRODUCT_INQUIRY, Intent.PRICE_INQUIRY) and not matches and not wants_something and not sig["price"]:
        conf = 0.6
    if not matches and intents[0] == Intent.PRODUCT_INQUIRY and not sig["catalog"] and ent.max_price is None:
        conf = min(conf, 0.7)
    return result(intents, conf, topic=faq, faq_number=faq_number)


_DECLINE_CORE = {"لا", "الغي", "الغيه", "كنسل", "cancel", "بلاش", "no", "nevermind", "nope"}
_DECLINE_FILLER = {"never", "mind", "thanks", "thank", "you", "not", "now", "please", "order", "the", "my", "خلاص", "مش", "عايز", "عايزه", "عاوز", "دلوقتي", "شكرا", "الطلب", "الحجز", "تمام", "هفكر"}
_NO_WORDS = {"لا", "لأ", "no", "nope", "nevermind", "بلاش"}


def is_decline(text: str, context: str = "order") -> bool:
    """The customer backs out of what we just asked.

    context="order":  the order summary: 'لا خلاص الغي' / 'بلاش' / 'cancel'.
    context="cancel"/"modify": we asked to confirm cancelling/changing an order, so "لا", "متلغيش", "سيبه",
    "don't cancel", "keep it" mean *leave the order alone*, while "الغي"/"cancel" themselves mean YES (not a decline)."""
    toks = normalize(text).split()
    if not toks:
        return False
    if context in _ACTIONS:
        yes_words, no_words = _ACTIONS[context]
        allowed = (_NO_WORDS | no_words | _ACTION_FILLER | yes_words | _CONFIRM_WORDS
                   | {"never", "mind", "thanks", "thank", "you", "not", "now"})   # "ايوه متلغيش" contradicts itself: don't act
        if is_pure_confirmation(text, context) or not all(t in allowed for t in toks):
            return False
        return any(t in _NO_WORDS or t in no_words for t in toks)
    return any(t in _DECLINE_CORE for t in toks) and all(t in _DECLINE_CORE or t in _DECLINE_FILLER for t in toks)
