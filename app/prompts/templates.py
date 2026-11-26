"""Fixed reply templates (the verified draft of every reply).

Rules: short, friendly, no bullets/markdown/emoji, products on separate lines, and NEVER a promise the system cannot
keep ("I'll check with the team") or a claim that an order was accepted (only the owner approves orders).
"""
from __future__ import annotations

from ..schemas import Language

AR: dict[str, str] = {
    # fixed, no generation needed
    "GREETING": "أهلاً بيك! أقدر أساعدك إزاي؟",
    "GREETING_SALAM": "وعليكم السلام ورحمة الله وبركاته! أقدر أساعدك إزاي؟",
    "THANKYOU": "العفو! لو عايز حاجة تانية أنا موجود.",
    "UNKNOWN": "معلش مش فاهم قصدك. ممكن توضحلي عايز إيه؟",
    "DECLINED": "تمام، مفيش مشكلة. لو عايز حاجة تانية أنا موجود.",
    # products / prices
    "ONE_PRODUCT": "عندنا {name} بـ {price} جنيه.",
    "MANY_PRODUCTS": "عندنا:\n{lines}",
    "PICK_ONE": "تحب تختار أنهي واحد؟",
    "ASK_ORDER": "تحب تطلبه؟",
    "LINE": "{name} بـ {price} جنيه",
    "LINE_LOW": "{name} بـ {price} جنيه، باقي {left} بس",
    "LINE_NO_PRICE": "{name}، السعر مش متسجل عندي دلوقتي",
    "OPTIONS_COLORS": "الألوان المتاحة: {items}.",
    "OPTIONS_SIZES": "المقاسات المتاحة: {items}.",
    "SOLD_OUT": "للأسف {name} خلص حاليًا.",
    "SOLD_OUT_PLUS": "{name} خلص حاليًا.",
    "ALTERNATIVES": "بس عندنا:\n{lines}",
    "NOT_FOUND": "معلش مش لاقي {term} عندنا حاليًا.\n{categories}",
    "NO_COLOR": "مفيش {name} باللون {color} حاليًا.",
    "COLORS_AVAILABLE": "المتاح بالألوان: {items}.",
    "CATEGORIES": "عندنا {items}. تحب تشوف أنهي قسم؟",
    "PRICE_ONE": "{name} بـ {price} جنيه.",
    "PRICE_NO_PRICE": "سعر {name} مش متسجل عندي دلوقتي.",
    "PRICE_ASK": "قوللي اسم المنتج اللي عايز تعرف سعره وأنا أقولك.",
    "SIZE_NA": "مقاس {size} مش متاح.",
    # orders
    "ORDER_SUMMARY": "تمام! {desc}، كمية {qty}، الإجمالي {total} جنيه.\nتحب تأكد الطلب؟",
    "ORDER_SUMMARY_NO_TOTAL": "تمام! {desc}، كمية {qty}.\nتحب تأكد الطلب؟",
    "BOOKING_SUMMARY": "تمام! {desc}، الميعاد {time}، الإجمالي {total} جنيه.\nتحب تأكد الحجز؟",
    "PASSTHROUGH_NOTE": "{what} هيتأكد من صاحب المحل وقت مراجعة الطلب.",
    "WHAT_COLOR": "اللون",
    "WHAT_SIZE": "المقاس",
    "WHAT_BOTH": "اللون والمقاس",
    "ORDER_CONFIRMED": "تمام، هجهز طلبك للمراجعة: {desc}، كمية {qty}.",
    "BOOKING_CONFIRMED": "تمام، هجهز حجزك للمراجعة: {desc}، الميعاد {time}.",
    "ASK_PRODUCT": "تمام، تحب تطلب أنهي منتج؟",
    "ASK_WHICH": "عندنا:\n{lines}\nتحب أنهي واحد؟",
    "ASK_SLOTS": "تمام، {name}. تحب {what}؟",
    "ASK_SLOTS_INVALID": "{invalid}\nتحب {what}؟",
    "ASK_TIME": "تمام، {name}. تحب الميعاد امتى؟",
    "ASK_COLOR_SIZE": "أنهي لون ومقاس؟ وكام واحدة",
    "ASK_COLOR_SIZE_ONLY": "أنهي لون ومقاس",
    "ASK_COLOR": "أنهي لون",
    "ASK_SIZE": "أنهي مقاس",
    "ASK_COLOR_QTY": "أنهي لون؟ وكام واحدة",
    "ASK_SIZE_QTY": "أنهي مقاس؟ وكام واحدة",
    "ASK_QTY": "تطلب كام واحدة",
    "INVALID_COLOR": "اللون {color} مش متاح.",
    "INVALID_SIZE": "المقاس {size} مش متاح.",
    "NOT_ENOUGH": "المتاح من {name} {left} بس. تحب تطلب الكمية دي؟",
    "QTY_TOO_LARGE": "أقصى كمية في الطلب الواحد 100. تحب تطلب كام؟",
    # follow-up / complaints
    "FOLLOW_ONE": "طلبك رقم {number} ({items}) حالته: {status}.",
    "FOLLOW_MANY": "طلباتك الحالية:\n{lines}",
    "FOLLOW_NONE": "مش لاقي طلبات على رقمك. ممكن تبعتلي رقم الطلب؟",
    "FOLLOW_REF_NOT_FOUND": "مش لاقي طلب رقم {ref} على رقمك. ممكن تتأكد من الرقم؟",
    "FOLLOW_UNSUPPORTED": "معنديش وصول لحالة الطلبات دلوقتي.",
    "COMPLAINT": "آسف إن الطلب اتأخر. ممكن تبعتلي رقم الطلب؟",
    "COMPLAINT_DELAY_KNOWN": "آسف إن الطلب اتأخر. أنا شايف طلبك رقم {number} وحالته: {status}.",
    "COMPLAINT_KNOWN": "آسف على اللي حصل. أنا شايف طلبك رقم {number} وحالته: {status}.\nممكن تقولي إيه المشكلة بالظبط؟",
    "COMPLAINT_GENERIC": "آسف على اللي حصل. ممكن تقولي إيه المشكلة بالظبط؟",
    # business information
    "HOURS": "بنشتغل {parts}.",
    "HOURS_NONE": "مواعيد العمل مش متسجلة عندي دلوقتي.",
    "DELIVERY_NO": "التوصيل مش متاح حالياً، والاستلام من الفرع متاح.",
    "DELIVERY_NO_NOPICKUP": "التوصيل مش متاح حالياً.",
    "DELIVERY_YES": "التوصيل متاح، والأسعار هتتحدد من صاحب المحل.",
    "DELIVERY_YES_PICKUP": "التوصيل متاح، والأسعار هتتحدد من صاحب المحل. والاستلام من الفرع متاح كمان.",
    "PAY_CASH": "بنقبل الدفع كاش.",
    "PAY_ONLINE": "بنقبل الدفع أونلاين.",
    "PAY_BOTH": "بنقبل الدفع كاش وأونلاين.",
    "PAY_NONE": "طرق الدفع مش متسجلة عندي دلوقتي.",
    "ADDRESS": "عنواننا: {address}.",
    "ADDRESS_NONE": "العنوان مش متسجل عندي دلوقتي.",
    "PHONE": "تقدر تكلمنا على {phone}.",
    "PHONE_NONE": "رقم التواصل مش متسجل عندي دلوقتي.",
    "FAQ_UNKNOWN": "معلش معنديش معلومة مؤكدة عن ده دلوقتي. تقدر تسألني عن المنتجات أو التوصيل أو المواعيد.",
    # help / customer service
    "HELP": ("تقدر تكتبلي اسم المنتج اللي عايزه وأنا أقولك السعر والمتاح.\n"
             "ولما تحب تطلب، قولي الكمية (واللون والمقاس لو فيه)، وبعدها هتأكد الطلب.\n"
             "وتقدر تسألني كمان عن المواعيد والتوصيل والدفع."),
    "ASK_WHICH_ORDER": "قصدك أنهي طلب؟\n{lines}",
    "NO_ACTIVE_ORDER": "مفيش طلب شغال على رقمك أقدر أتعامل معاه. ممكن تبعتلي رقم الطلب؟",
    "CANCEL_ASK": "عايز تلغي طلب رقم {number} ({items})؟ اكتب (ايوه) لتأكيد الإلغاء.",
    "CANCEL_ASK_NONUM": "عايز تلغي الطلب؟ اكتب (ايوه) لتأكيد الإلغاء.",
    "CANCEL_DONE": "تمام. إلغاء طلب رقم {number} محتاج صاحب المحل يأكده بنفسه.",
    "CANCEL_DONE_NONUM": "تمام. الإلغاء محتاج صاحب المحل يأكده بنفسه.",
    "MODIFY_ASK": "عايز تعدّل طلب رقم {number} ({items})؟ اكتب (ايوه) لتأكيد التعديل.",
    "MODIFY_ASK_NONUM": "عايز تعدّل الطلب؟ اكتب (ايوه) لتأكيد التعديل.",
    "MODIFY_DONE": "تمام. تعديل طلب رقم {number} محتاج صاحب المحل يأكده بنفسه. ممكن تكتبلي التعديل المطلوب بالتفصيل؟",
    "MODIFY_DONE_NONUM": "تمام. التعديل محتاج صاحب المحل يأكده بنفسه. ممكن تكتبلي التعديل المطلوب بالتفصيل؟",
    "KEEP_AS_IS": "تمام، الطلب زي ما هو.",
    "PAYMENT_DISPUTE": ("آسف على اللي حصل. ممكن تبعتلي رقم الطلب وطريقة الدفع ووقت الدفع بالتقريب؟\n"
                        "ده بيساعد صاحب المحل يراجع الموضوع."),
    "LEGAL_THREAT": ("آسف إنك متضايق للدرجة دي. ممكن تكتبلي المشكلة بالتفصيل ورقم الطلب لو موجود؟\n"
                     "ده بيساعد صاحب المحل يراجعها."),
    "CUSTOM_REQUEST": ("الطلبات المخصوصة بتتفق عليها مع صاحب المحل مباشرة.\n"
                       "ممكن تكتبلي تفاصيل اللي عايزه (الفكرة، الكمية، الميعاد)؟"),
    "FOLLOW_ETA_NOTE": "ومعنديش موعد وصول مؤكد.",
    # budget (max_price)
    "UNDER_BUDGET": "المتاح تحت {max} جنيه:\n{lines}",
    "NONE_UNDER_BUDGET": "مفيش {term} تحت {max} جنيه حاليًا. أرخص واحد: {name} بـ {price} جنيه.",
    "NONE_UNDER_BUDGET_ANY": "مفيش منتجات تحت {max} جنيه حاليًا.",
    # pieces for hours
    "H_FROM_TO_DAYS": "من {a} {b}",
    "H_AND": "و",
    "H_CLOSED": "{day} إجازة",
    "H_TIME": "من {a} لـ {b}",
}

EN: dict[str, str] = {
    "GREETING": "Hi! How can I help you?",
    "GREETING_SALAM": "Hi! How can I help you?",
    "THANKYOU": "You're welcome! Let me know if you need anything else.",
    "UNKNOWN": "Sorry, I didn't get that. Could you tell me what you're looking for?",
    "DECLINED": "No problem. Let me know if you need anything else.",
    "ONE_PRODUCT": "We have {name} for {price} EGP.",
    "MANY_PRODUCTS": "We have:\n{lines}",
    "PICK_ONE": "Which one would you like?",
    "ASK_ORDER": "Would you like to order it?",
    "LINE": "{name} for {price} EGP",
    "LINE_LOW": "{name} for {price} EGP, only {left} left",
    "LINE_NO_PRICE": "{name}, the price isn't on file right now",
    "OPTIONS_COLORS": "Available colors: {items}.",
    "OPTIONS_SIZES": "Available sizes: {items}.",
    "SOLD_OUT": "Sorry, {name} is out of stock right now.",
    "SOLD_OUT_PLUS": "{name} is out of stock right now.",
    "ALTERNATIVES": "But we have:\n{lines}",
    "NOT_FOUND": "Sorry, we don't have {term} right now.\n{categories}",
    "NO_COLOR": "We don't have {name} in {color} right now.",
    "COLORS_AVAILABLE": "Available colors: {items}.",
    "CATEGORIES": "We have {items}. Which category would you like to see?",
    "PRICE_ONE": "{name} is {price} EGP.",
    "PRICE_NO_PRICE": "The price of {name} isn't on file right now.",
    "PRICE_ASK": "Tell me which product you want the price of.",
    "SIZE_NA": "Size {size} isn't available.",
    "ORDER_SUMMARY": "Got it! {desc}, quantity {qty}, total {total} EGP.\nWould you like to confirm the order?",
    "ORDER_SUMMARY_NO_TOTAL": "Got it! {desc}, quantity {qty}.\nWould you like to confirm the order?",
    "BOOKING_SUMMARY": "Got it! {desc}, time {time}, total {total} EGP.\nWould you like to confirm the booking?",
    "PASSTHROUGH_NOTE": "The requested {what} will be confirmed by the store owner when the order is reviewed.",
    "WHAT_COLOR": "color",
    "WHAT_SIZE": "size",
    "WHAT_BOTH": "color and size",
    "ORDER_CONFIRMED": "Great, I'll prepare your order for review: {desc}, quantity {qty}.",
    "BOOKING_CONFIRMED": "Great, I'll prepare your booking for review: {desc}, time {time}.",
    "ASK_PRODUCT": "Sure, which product would you like to order?",
    "ASK_WHICH": "We have:\n{lines}\nWhich one would you like?",
    "ASK_SLOTS": "Sure, {name}. {what}",
    "ASK_SLOTS_INVALID": "{invalid}\n{what}",
    "ASK_TIME": "Sure, {name}. What time would you like?",
    "ASK_COLOR_SIZE": "Which color and size, and how many would you like?",
    "ASK_COLOR_SIZE_ONLY": "Which color and size would you like?",
    "ASK_COLOR": "Which color would you like?",
    "ASK_SIZE": "Which size would you like?",
    "ASK_COLOR_QTY": "Which color, and how many would you like?",
    "ASK_SIZE_QTY": "Which size, and how many would you like?",
    "ASK_QTY": "How many would you like?",
    "INVALID_COLOR": "The color {color} isn't available.",
    "INVALID_SIZE": "Size {size} isn't available.",
    "NOT_ENOUGH": "Only {left} of {name} available. Would you like that quantity?",
    "QTY_TOO_LARGE": "The maximum quantity per order is 100. How many would you like?",
    "FOLLOW_ONE": "Your order #{number} ({items}) status: {status}.",
    "FOLLOW_MANY": "Your current orders:\n{lines}",
    "FOLLOW_NONE": "I can't find any orders for your number. Could you send the order number?",
    "FOLLOW_REF_NOT_FOUND": "I can't find order #{ref} for your number. Could you double-check the number?",
    "FOLLOW_UNSUPPORTED": "I can't see order statuses right now.",
    "COMPLAINT": "Sorry your order is late. Could you send me the order number?",
    "COMPLAINT_DELAY_KNOWN": "Sorry your order is late. I can see your order #{number}, status: {status}.",
    "COMPLAINT_KNOWN": "Sorry about that. I can see your order #{number}, status: {status}.\nCould you tell me exactly what the problem is?",
    "COMPLAINT_GENERIC": "Sorry about that. Could you tell me exactly what the problem is?",
    "HOURS": "We're open {parts}.",
    "HOURS_NONE": "I don't have the working hours on file right now.",
    "DELIVERY_NO": "Delivery isn't available right now, but pickup from the store is available.",
    "DELIVERY_NO_NOPICKUP": "Delivery isn't available right now.",
    "DELIVERY_YES": "Delivery is available, and the fees will be set by the store owner.",
    "DELIVERY_YES_PICKUP": "Delivery is available, and the fees will be set by the store owner. Pickup from the store is available too.",
    "PAY_CASH": "We accept cash payment.",
    "PAY_ONLINE": "We accept online payment.",
    "PAY_BOTH": "We accept cash and online payment.",
    "PAY_NONE": "Payment methods aren't on file right now.",
    "ADDRESS": "Our address: {address}.",
    "ADDRESS_NONE": "The address isn't on file right now.",
    "PHONE": "You can reach us at {phone}.",
    "PHONE_NONE": "The contact number isn't on file right now.",
    "FAQ_UNKNOWN": "Sorry, I don't have confirmed information about that right now. You can ask me about products, delivery or working hours.",
    # help / customer service
    "HELP": ("Just type the product you want and I'll tell you the price and what's available.\n"
             "When you're ready to order, tell me the quantity (and color and size if needed), then you'll confirm the order.\n"
             "You can also ask me about working hours, delivery and payment."),
    "ASK_WHICH_ORDER": "Which order do you mean?\n{lines}",
    "NO_ACTIVE_ORDER": "I can't find an active order for your number that I can help with. Could you send the order number?",
    "CANCEL_ASK": "Do you want to cancel order #{number} ({items})? Reply yes to confirm the cancellation.",
    "CANCEL_ASK_NONUM": "Do you want to cancel the order? Reply yes to confirm the cancellation.",
    "CANCEL_DONE": "Okay. Cancelling order #{number} needs to be confirmed by the store owner.",
    "CANCEL_DONE_NONUM": "Okay. The cancellation needs to be confirmed by the store owner.",
    "MODIFY_ASK": "Do you want to change order #{number} ({items})? Reply yes to confirm the change.",
    "MODIFY_ASK_NONUM": "Do you want to change the order? Reply yes to confirm the change.",
    "MODIFY_DONE": "Okay. Changing order #{number} needs to be confirmed by the store owner. Could you describe the change you need?",
    "MODIFY_DONE_NONUM": "Okay. The change needs to be confirmed by the store owner. Could you describe the change you need?",
    "KEEP_AS_IS": "Okay, the order stays as it is.",
    "PAYMENT_DISPUTE": ("Sorry about that. Could you send the order number, the payment method and roughly when you paid?\n"
                        "That helps the store owner look into it."),
    "LEGAL_THREAT": ("Sorry you're this upset. Could you describe the problem in detail, with the order number if you have one?\n"
                     "That helps the store owner look into it."),
    "CUSTOM_REQUEST": ("Custom requests are agreed directly with the store owner.\n"
                       "Could you write the details of what you want (the idea, quantity, timing)?"),
    "FOLLOW_ETA_NOTE": "I don't have a confirmed arrival time.",
    "UNDER_BUDGET": "Available under {max} EGP:\n{lines}",
    "NONE_UNDER_BUDGET": "We don't have {term} under {max} EGP right now. The cheapest is {name} for {price} EGP.",
    "NONE_UNDER_BUDGET_ANY": "We don't have any products under {max} EGP right now.",
    "H_FROM_TO_DAYS": "{a} to {b}",
    "H_AND": "and ",
    "H_CLOSED": "closed on {day}",
    "H_TIME": "{a}–{b}",
}

TEMPLATES: dict[str, dict[str, str]] = {"ar": AR, "en": EN}

DAYS = {
    "ar": {"SATURDAY": "السبت", "SUNDAY": "الأحد", "MONDAY": "الاثنين", "TUESDAY": "الثلاثاء",
           "WEDNESDAY": "الأربع", "THURSDAY": "الخميس", "FRIDAY": "الجمعة"},
    "en": {"SATURDAY": "Saturday", "SUNDAY": "Sunday", "MONDAY": "Monday", "TUESDAY": "Tuesday",
           "WEDNESDAY": "Wednesday", "THURSDAY": "Thursday", "FRIDAY": "Friday"},
}
# Egyptian week order (Saturday first)
WEEK_ORDER = ["SATURDAY", "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]

STATUS = {
    "ar": {"PENDING": "مستني التأكيد", "PENDING_APPROVAL": "مستني موافقة صاحب المحل", "IN_PROGRESS": "قيد التنفيذ",
           "COMPLETED": "اتسلم", "CANCELLED": "اتلغى"},
    "en": {"PENDING": "pending", "PENDING_APPROVAL": "waiting for the owner's approval", "IN_PROGRESS": "in progress",
           "COMPLETED": "delivered", "CANCELLED": "cancelled"},
}

# phrases our own replies contain; matched (after normalisation) against the store's last message to know what the
# customer is answering: a question we asked, or the order summary awaiting confirmation.
CLARIFICATION_MARKERS = (
    "تحب تختار أنهي", "تحب أنهي", "كام واحدة", "الميعاد امتى", "تحب تطلب أنهي", "المقاسات المتاحة",
    "الألوان المتاحة", "تحب تأكد", "أنهي لون", "أنهي مقاس",
    "which one would you like", "which order do you mean", "قصدك أنهي طلب", "which color", "which size", "available colors", "available sizes",
    "how many", "what time would you like", "would you like to confirm", "which product would you like",
)
CONFIRM_MARKERS = ("تحب تأكد الطلب", "تحب تأكد الحجز", "would you like to confirm the order",
                   "would you like to confirm the booking")


# What the customer is answering when our last message asked them to confirm cancelling / changing an existing order.
CANCEL_CONFIRM_MARKERS = ("لتأكيد الإلغاء", "to confirm the cancellation")
MODIFY_CONFIRM_MARKERS = ("لتأكيد التعديل", "to confirm the change")


def t(lang: Language, key: str, **kw: object) -> str:
    return TEMPLATES[lang][key].format(**kw)
