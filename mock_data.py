"""Mock data for developing the AI service before the NestJS backend is wired to WhatsApp.

Shapes mirror the backend's Prisma models (Business / CatalogItem / Order) and the AI request contract, so swapping
this file for real backend calls later changes nothing in the engine. Stable UUIDs (uuid5) make test output repeatable.

Product option conventions (stored in CatalogItem.attributes):
    color: "أسود"                      fixed colour (a separate item per colour)
    colors: ["أسود", "رمادي"]          customer must choose one
    sizes: ["S", "M", "L"]             customer must choose one
    type: "SERVICE", requiresAppointment: true   salon services (order == booking)
    aliases: ["..."]                   extra search words
trackInventory=false -> stock is not tracked (always available); true -> stockQuantity is enforced.
"""
from __future__ import annotations

import copy
import re
import uuid
from typing import Any

from app.nlu import normalize, search_products
from app.schemas import CatalogItem

_NS = uuid.UUID("5f0f5c1e-7a52-4d0c-9b5e-0b7b6f1e2a10")


def _id(*parts: str) -> str:
    return str(uuid.uuid5(_NS, ":".join(parts)))


class CustomerNotFound(KeyError):
    """No mock customer with that WhatsApp number."""


# ----------------------------------------------------------------------------- businesses

BUSINESS_IDS = {"style": _id("biz", "style"), "lamma": _id("biz", "lamma"), "reem": _id("biz", "reem")}
_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]


def _hours(week: tuple[str, str], friday: tuple[str, str] | None) -> list[dict[str, Any]]:
    """Working-hour ROWS, exactly how the backend returns them (a list, one row per day)."""
    rows = []
    for d in _DAYS:
        hrs = friday if d == "FRIDAY" else week
        rows.append({"dayOfWeek": d, "isOpen": hrs is not None, "opensAt": hrs[0] if hrs else None,
                     "closesAt": hrs[1] if hrs else None})
    return rows


BUSINESSES: dict[str, dict[str, Any]] = {
    BUSINESS_IDS["style"]: {
        "id": BUSINESS_IDS["style"], "name": "ستايل هاوس", "description": "محل ملابس واكسسوارات", "category": "Clothing",
        "phone": "01000000001", "address": "12 شارع محمود بسيوني، وسط البلد، القاهرة",
        "settings": {"acceptsCash": True, "acceptsOnlinePayment": True, "deliveryEnabled": True, "pickupEnabled": True},
        "workingHours": _hours(("11:00", "23:00"), ("14:00", "23:00")),
        "knowledge": {"policies": {"returns": "الاستبدال والاسترجاع متاح خلال 14 يوم من الاستلام بشرط المنتج يكون بحالته."},
                      "faqs": [{"question": "الخامة قطن؟", "keywords": ["خامه", "قطن"], "answer": "التيشيرتات والهوديز قطن 100%."},
                               {"question": "اللمبة الحمرا معلقة في السماعة", "keywords": ["لمبه", "حمرا", "الحمرا"],
                                "answer": "اللمبة الحمرا معناها إن البطارية ضعيفة. اشحنها وهتطفي."}]},
    },
    BUSINESS_IDS["lamma"]: {
        "id": BUSINESS_IDS["lamma"], "name": "مطعم لمّة العيلة", "description": "أكل مصري وبيتزا", "category": "Restaurant",
        "phone": "01000000002", "address": "فرع المعادي: شارع 9، جنب محطة المترو",
        "settings": {"acceptsCash": True, "acceptsOnlinePayment": False, "deliveryEnabled": True, "pickupEnabled": True},
        "workingHours": _hours(("12:00", "02:00"), ("12:00", "02:00")),
        "knowledge": {"policies": {}, "faqs": [{"question": "في أطباق نباتي؟", "keywords": ["نباتي", "نباتيين"],
                                                "answer": "أيوه، الكشري وبيتزا المارجريتا نباتي."},
                                               {"question": "الموز بيوصل امتى؟", "keywords": ["موز", "الموز"],
                                                "answer": "الموز بيوصل طازج كل يوم الصبح."}]},
    },
    BUSINESS_IDS["reem"]: {
        "id": BUSINESS_IDS["reem"], "name": "صالون ريم", "description": "صالون سيدات", "category": "Beauty",
        "phone": "01000000003", "address": "5 شارع التحرير، الدقي، الدور التاني",
        "settings": {"acceptsCash": True, "acceptsOnlinePayment": True, "deliveryEnabled": False, "pickupEnabled": True},
        "workingHours": _hours(("10:00", "21:00"), None),
        "knowledge": {"policies": {"returns": "ينفع تلغي أو تأجل الحجز قبلها بـ 3 ساعات على الأقل."},
                      "faqs": [{"question": "في عروض للعرايس؟", "keywords": ["عروض", "عرايس", "عروسه", "باكدج"],
                                "answer": "أيوه، في باكدج للعروسة. كلمينا نظبط الميعاد."},
                               {"question": "الباقة بكام؟", "keywords": ["باقه", "الباقه", "باقات", "الباقات"],
                                "answer": "باقة العروسة بتبدأ من 6000 جنيه."}]},
    },
}

# ----------------------------------------------------------------------------- products


def _flat(attrs: dict[str, Any]) -> dict[str, Any]:
    """Owner-style FLAT attributes, like the Excel import creates them ({"Color": "Black, Gray", "Size": "S, M"})."""
    out: dict[str, Any] = {}
    colors = attrs.get("colors") or ([attrs["color"]] if attrs.get("color") else [])
    if colors:
        out["Color"] = ", ".join(colors)
    if attrs.get("sizes"):
        out["Size"] = ", ".join(attrs["sizes"])
    if attrs.get("material"):
        out["Material"] = attrs["material"]
    if attrs.get("type") == "SERVICE":
        out["Type"] = "Service"
        out["Duration (min)"] = attrs.get("durationMinutes")
    return out


def _p(biz: str, key: str, name: str, category: str, price: str | None, stock: int | None = None,
       track: bool | None = None, active: bool = True, **attrs: Any) -> dict[str, Any]:
    track = (stock is not None) if track is None else track
    return {
        "id": _id("prod", key), "businessId": BUSINESS_IDS[biz], "externalKey": key, "name": name,
        "description": attrs.pop("description", None), "category": category, "basePrice": price,
        "trackInventory": track, "stockQuantity": stock if track else None, "attributes": _flat(attrs) or None,
        "isActive": active,
    }


_SIZES = ["S", "M", "L", "XL"]
_NUM = ["30", "32", "34", "36"]
_SHOE = ["40", "41", "42", "43", "44", "45"]


def _svc(key: str, name: str, cat: str, price: str, minutes: int) -> dict[str, Any]:
    return _p("reem", key, name, cat, price, type="SERVICE", durationMinutes=minutes, requiresAppointment=True)


PRODUCTS: list[dict[str, Any]] = [
    # --- ستايل هاوس (ملابس + إكسسوارات + إلكترونيات)
    _p("style", "TS-BLK", "تيشيرت قطن أسود", "تيشيرتات", "200.00", 25, color="أسود", material="قطن", sizes=_SIZES),
    _p("style", "TS-WHT", "تيشيرت قطن أبيض", "تيشيرتات", "180.00", 12, color="أبيض", material="قطن", sizes=_SIZES),
    _p("style", "TS-PLO", "تيشيرت بولو", "تيشيرتات", "250.00", 8, colors=["كحلي", "رمادي", "أبيض"], sizes=["M", "L", "XL"]),
    _p("style", "TS-OVR", "تيشيرت أوفر سايز", "تيشيرتات", "220.00", 0, colors=["أسود", "بيج"], sizes=["M", "L", "XL"]),
    _p("style", "HD-CAS", "هودي كاجوال", "هوديز", "450.00", 15, colors=["أسود", "رمادي", "كحلي"], sizes=_SIZES, material="قطن"),
    _p("style", "HD-ZIP", "هودي بسوستة", "هوديز", "520.00", 3, color="رمادي", sizes=["M", "L", "XL"]),
    _p("style", "JN-SLM", "بنطلون جينز سليم", "بناطيل", "550.00", 20, colors=["أزرق", "أسود"], sizes=_NUM),
    _p("style", "JN-BAG", "بنطلون جينز واسع", "بناطيل", "600.00", 0, color="أزرق", sizes=_NUM),
    _p("style", "CH-CHN", "بنطلون شينو", "بناطيل", "480.00", 9, colors=["بيج", "زيتي"], sizes=_NUM),
    _p("style", "JK-DNM", "جاكيت جينز", "جاكيتات", "750.00", 6, color="أزرق", sizes=["M", "L", "XL"]),
    _p("style", "JK-BMB", "جاكيت بومبر", "جاكيتات", "900.00", 4, colors=["أسود", "أخضر"], sizes=["M", "L", "XL"]),
    _p("style", "DR-CAS", "فستان كاجوال", "فساتين", "800.00", 5, colors=["أسود", "وردي"], sizes=["S", "M", "L"]),
    _p("style", "SH-SNK", "حذاء سنيكرز أبيض", "أحذية", "950.00", 14, color="أبيض", sizes=_SHOE, aliases=["كوتشي"]),
    _p("style", "SH-SND", "صندل جلد", "أحذية", "350.00", 22, color="بني", sizes=_SHOE[:5]),
    _p("style", "AC-BLT", "حزام جلد", "إكسسوارات", "150.00", 30, colors=["أسود", "بني"]),
    _p("style", "AC-CAP", "كاب قطن", "إكسسوارات", "120.00", None, track=False, colors=["أسود", "كحلي", "بيج"]),
    _p("style", "AC-BAG", "شنطة ظهر", "إكسسوارات", "400.00", 7, color="أسود"),
    _p("style", "AC-WLT", "محفظة جلد", "إكسسوارات", "220.00", 18, color="بني"),
    _p("style", "EL-EAR", "سماعات بلوتوث", "إلكترونيات", "850.00", 11, colors=["أبيض", "أسود"]),
    _p("style", "EL-CHG", "شاحن سريع 20 وات", "إلكترونيات", "300.00", 40),
    _p("style", "EL-WCH", "ساعة ذكية", "إلكترونيات", "1500.00", 2, color="أسود"),
    # --- مطعم لمّة العيلة
    _p("lamma", "R-KSH", "كشري طبق وسط", "وجبات رئيسية", "60.00"),
    _p("lamma", "R-CHK", "نص فرخة مشوية", "وجبات رئيسية", "160.00"),
    _p("lamma", "R-KBB", "كباب مشكل نص كيلو", "وجبات رئيسية", "420.00"),
    _p("lamma", "R-BRG", "برجر لحم", "ساندوتشات", "120.00"),
    _p("lamma", "R-SHW", "شاورما فراخ", "ساندوتشات", "95.00"),
    _p("lamma", "R-PZM", "بيتزا مارجريتا", "بيتزا", "140.00"),
    _p("lamma", "R-PZX", "بيتزا مشكل", "بيتزا", "190.00"),
    _p("lamma", "R-KNF", "كنافة بالمكسرات", "حلويات", "85.00", 6),
    _p("lamma", "R-OML", "أم علي", "حلويات", "70.00", 0),
    _p("lamma", "R-JMG", "عصير مانجو", "مشروبات", "45.00"),
    _p("lamma", "R-JOR", "عصير برتقال طازج", "مشروبات", "50.00"),
    _p("lamma", "R-SOD", "مياه غازية", "مشروبات", "25.00", aliases=["بيبسي", "كولا"]),
    _p("lamma", "R-COF", "قهوة تركي", "مشروبات", "35.00"),
    # --- صالون ريم (خدمات)
    _svc("S-CUT", "قص شعر", "شعر", "250.00", 45),
    _svc("S-BLW", "سشوار", "شعر", "150.00", 30),
    _svc("S-DYR", "صبغة جذور", "شعر", "600.00", 90),
    _svc("S-DYF", "صبغة كاملة", "شعر", "1200.00", 150),
    _svc("S-KER", "كيراتين", "شعر", "2500.00", 180),
    _svc("S-MAN", "مانيكير", "أظافر", "180.00", 40),
    _svc("S-PED", "باديكير", "أظافر", "220.00", 50),
    _svc("S-MKN", "ميك أب سهرة", "مكياج", "900.00", 60),
    _svc("S-MKB", "ميك أب عروسة", "مكياج", "4500.00", 120),
    _svc("S-FAC", "تنظيف بشرة", "بشرة", "500.00", 60),
    # soft-deleted items (isActive=false): must never be offered
    _p("style", "OLD-TS", "تيشيرت قديم", "تيشيرتات", "99.00", 50, active=False, color="أحمر", sizes=_SIZES),
    _p("lamma", "OLD-JUS", "عصير فراولة", "مشروبات", "40.00", active=False),
]
_PRODUCT_BY_KEY = {p["externalKey"]: p for p in PRODUCTS}

# ----------------------------------------------------------------------------- customers

_CUSTOMER_ROWS = [
    ("c1", "style", "أحمد سمير", "201000000001"), ("c2", "style", "منى حسن", "201000000002"),
    ("c3", "style", "كريم عادل", "201000000003"), ("c4", "style", "نور الهدى", "201000000004"),
    ("c5", "lamma", "محمود فتحي", "201000000005"), ("c6", "lamma", "ياسمين طارق", "201000000006"),
    ("c7", "lamma", "عمر خالد", "201000000007"), ("c8", "reem", "هبة مصطفى", "201000000008"),
    ("c9", "reem", "سارة إبراهيم", "201000000009"), ("c10", "reem", "مريم أشرف", "201000000010"),
]
CUSTOMERS: list[dict[str, Any]] = [
    {"id": _id("cust", k), "businessId": BUSINESS_IDS[b], "name": n, "waId": w, "createdAt": "2026-09-20T10:00:00Z"}
    for k, b, n, w in _CUSTOMER_ROWS
]
_CUST_KEY = {c["id"]: row[0] for c, row in zip(CUSTOMERS, _CUSTOMER_ROWS)}

# ----------------------------------------------------------------------------- conversations (3-5 earlier messages)

_I, _O = "INBOUND", "OUTBOUND"
_SALAM_REPLY = "وعليكم السلام ورحمة الله وبركاته! أقدر أساعدك إزاي؟"
_SCRIPTS: dict[str, list[tuple[str, str]]] = {
    # c1: in the middle of an order (we asked which tee) -> try "الاسود L اتنين"
    "c1": [(_I, "السلام عليكم"), (_O, _SALAM_REPLY), (_I, "عايز اطلب تيشيرت"),
           (_O, "عندنا:\nتيشيرت قطن أسود بـ 200 جنيه\nتيشيرت قطن أبيض بـ 180 جنيه\nتيشيرت بولو بـ 250 جنيه\nتحب تختار أنهي واحد؟")],
    # c2: we sent the order summary -> try "ايوه اكدي"
    "c2": [(_I, "عايزة اطلب هودي كاجوال"), (_O, "تمام، هودي كاجوال. تحب أنهي لون ومقاس؟ وكام واحدة؟\nالألوان المتاحة: أسود، رمادي، كحلي.\nالمقاسات المتاحة: S، M، L، XL."),
           (_I, "رمادي M واحد"), (_O, "تمام! هودي كاجوال رمادي مقاس M، كمية 1، الإجمالي 450 جنيه.\nتحب تأكد الطلب؟")],
    "c3": [(_I, "السلام عليكم"), (_O, _SALAM_REPLY), (_I, "الطلب وصل تمام"), (_O, "الحمد لله! لو عايز حاجة تانية أنا موجود.")],
    "c4": [(_I, "عندكم جينز؟"), (_O, "عندنا:\nبنطلون جينز سليم بـ 550 جنيه\nتحب تختار أنهي واحد؟"),
           (_I, "الواسع ده متاح؟"), (_O, "للأسف بنطلون جينز واسع خلص حاليًا.")],
    "c5": [(_I, "اهلا"), (_O, "أهلاً بيك! أقدر أساعدك إزاي؟"), (_I, "عايز اطلب كشري"),
           (_O, "تمام، كشري طبق وسط. تحب تطلب كام واحدة؟")],
    "c6": [(_I, "عايزة بيتزا مشكل"), (_O, "تمام، بيتزا مشكل. تحب تطلب كام واحدة؟"), (_I, "واحدة"),
           (_O, "تمام! بيتزا مشكل، كمية 1، الإجمالي 190 جنيه.\nتحب تأكد الطلب؟"), (_I, "لا خلاص الغي")],
    "c7": [(_I, "اهلا"), (_O, "أهلاً بيك! أقدر أساعدك إزاي؟"), (_I, "بتوصلوا المعادي؟"),
           (_O, "التوصيل متاح للمعادي بـ 30 جنيه، ومدينة نصر بـ 35 جنيه، والتجمع بـ 45 جنيه.")],
    "c8": [(_I, "عايزة احجز ميك اب سهرة"), (_O, "تمام، ميك أب سهرة. تحب الميعاد امتى؟"), (_I, "الجمعة الساعة 5 العصر"),
           (_O, "تمام! ميك أب سهرة، الميعاد الجمعة الساعة 5 العصر، الإجمالي 900 جنيه.\nتحب تأكد الحجز؟")],
    "c9": [(_I, "صباح الخير"), (_O, "أهلاً بيك! أقدر أساعدك إزاي؟"), (_I, "ايه اسعار الكيراتين؟"), (_O, "كيراتين بـ 2500 جنيه.")],
    "c10": [(_I, "السلام عليكم"), (_O, _SALAM_REPLY), (_I, "انا حجزت امبارح ومحدش كلمني"),
            (_O, "آسف على اللي حصل. ممكن تبعتلي رقم الطلب وتقولي إيه المشكلة بالظبط؟")],
}

CONVERSATIONS: list[dict[str, Any]] = []
MESSAGES: list[dict[str, Any]] = []
for _c in CUSTOMERS:
    _k = _CUST_KEY[_c["id"]]
    _conv_id = _id("conv", _k)
    CONVERSATIONS.append({"id": _conv_id, "customerId": _c["id"], "businessId": _c["businessId"],
                          "channel": "WHATSAPP", "status": "OPEN"})
    for _n, (_dir, _text) in enumerate(_SCRIPTS[_k]):
        MESSAGES.append({"id": _id("msg", _k, str(_n)), "conversationId": _conv_id, "direction": _dir, "type": "TEXT",
                         "text": _text, "createdAt": f"2026-10-06T12:{_n:02d}:00Z"})

# ----------------------------------------------------------------------------- orders (5)


def _line(key: str, qty: int, **attrs: str) -> dict[str, Any]:
    p = _PRODUCT_BY_KEY[key]
    return {"productId": p["id"], "name": p["name"], "quantity": qty, "unitPrice": p["basePrice"], "attributes": attrs}


def _order(num: int, cust: str, status: str, lines: list[dict[str, Any]], created: str) -> dict[str, Any]:
    total = sum(float(x["unitPrice"]) * x["quantity"] for x in lines)
    c = next(c for c, r in zip(CUSTOMERS, _CUSTOMER_ROWS) if r[0] == cust)
    return {"id": _id("order", str(num)), "orderNumber": num, "customerId": c["id"], "businessId": c["businessId"],
            "status": status, "items": lines, "total": f"{total:.2f}", "currency": "EGP", "createdAt": created}


ORDERS: list[dict[str, Any]] = [
    _order(1001, "c3", "COMPLETED", [_line("JN-SLM", 1, color="أزرق", size="34"), _line("AC-BLT", 1, color="بني")], "2026-09-28T15:00:00Z"),
    _order(1002, "c1", "IN_PROGRESS", [_line("HD-CAS", 1, color="أسود", size="L")], "2026-10-05T18:30:00Z"),
    _order(1003, "c5", "PENDING", [_line("R-KSH", 2), _line("R-JMG", 2)], "2026-10-06T13:10:00Z"),
    _order(1004, "c6", "CANCELLED", [_line("R-PZX", 1)], "2026-10-06T13:40:00Z"),
    _order(1005, "c8", "IN_PROGRESS", [_line("S-MKN", 1, preferredTime="الجمعة الساعة 5 العصر")], "2026-10-04T11:00:00Z"),
]

# ----------------------------------------------------------------------------- helper functions


def _digits(wa_id: str) -> str:
    d = re.sub(r"\D", "", wa_id or "")
    return "2" + d if d.startswith("0") and len(d) == 11 else d


def get_business(business_id: str) -> dict:
    return BUSINESSES[business_id]


def get_products(business_id: str, include_inactive: bool = True) -> list:
    return [p for p in PRODUCTS if p["businessId"] == business_id and (include_inactive or p["isActive"])]


def get_products_by_name(name: str, business_id: str | None = None) -> list:
    """Typo-tolerant search over ACTIVE products ('تشرت' finds the t-shirts)."""
    pool = [p for p in PRODUCTS if business_id in (None, p["businessId"]) and p["isActive"]]
    models = [CatalogItem.model_validate(p) for p in pool]
    ids = [str(m.id) for m in search_products(name, models)]
    return [p for i in ids for p in pool if str(p["id"]) == i]


def get_products_by_category(category: str, business_id: str | None = None) -> list:
    want = normalize(category)
    return [p for p in PRODUCTS if business_id in (None, p["businessId"]) and p["isActive"]
            and normalize(p["category"] or "") == want]


def get_customer_by_wa_id(wa_id: str) -> dict:
    d = _digits(wa_id)
    for c in CUSTOMERS:
        if c["waId"] == d:
            return c
    raise CustomerNotFound(wa_id)


def get_conversation(customer_id: str) -> dict:
    for c in CONVERSATIONS:
        if c["customerId"] == customer_id:
            return c
    raise KeyError(f"no conversation for customer {customer_id}")


def get_recent_messages(conversation_id: str, limit: int = 10) -> list:
    return [m for m in MESSAGES if m["conversationId"] == conversation_id][-limit:]


def get_customer_orders(customer_id: str) -> list:
    return [o for o in ORDERS if o["customerId"] == customer_id]


def build_request(customer_wa_id: str, message_text: str) -> dict:
    """The exact payload the NestJS backend sends to POST /v1/ai/respond, built from the database-shaped mock rows.

    Like the real endpoints it returns EVERYTHING: inactive products too, working hours as rows, and the conversation
    newest-first (the messages API order). The AI service must cope with all of that on its own."""
    customer = get_customer_by_wa_id(customer_wa_id)
    conversation = get_conversation(customer["id"])
    biz = BUSINESSES[customer["businessId"]]
    messages = get_recent_messages(conversation["id"], limit=30)
    return copy.deepcopy({   # a fresh copy per call, like a real HTTP response: callers may mutate it freely
        "business": {k: biz[k] for k in ("id", "name", "description", "category", "phone", "address", "settings",
                                         "workingHours")},
        "customer": {"id": customer["id"], "phone": customer["waId"], "name": customer["name"]},
        "conversation": [{"id": m["id"], "senderType": "CUSTOMER" if m["direction"] == _I else "AI",
                          "content": m["text"], "messageType": "TEXT", "createdAt": m["createdAt"]}
                         for m in reversed(messages)],
        "catalog": get_products(customer["businessId"], include_inactive=True),
        "businessKnowledge": biz["knowledge"],
        "customerOrders": [{"orderNumber": o["orderNumber"], "status": o["status"], "createdAt": o["createdAt"],
                            "items": [{"name": i["name"], "quantity": i["quantity"]} for i in o["items"]]}
                           for o in get_customer_orders(customer["id"])],
        "message": message_text,
        "messageId": str(uuid.uuid4()),
    })


build_ai_request = build_request   # backwards-compatible name
