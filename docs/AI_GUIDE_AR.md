# دليل فهم واختبار جزء الـ AI في Brandora

## 1. ما وظيفة خدمة AI؟

خدمة AI ليست قاعدة بيانات المنتجات، وليست WhatsApp، وليست مسؤولة عن خصم المخزون. هي طبقة moderator بين رسالة العميل وبيانات Backend الموثوقة.

وظيفتها الأساسية:

1. تستقبل رسالة العميل الحالية مع هوية النشاط والعميل والمحادثة والرسالة.
2. تفهم المطلوب: سؤال منتج، سعر، توافر، متابعة لسؤال سابق، رغبة شراء، أو مشكلة.
3. إذا احتاجت معلومة، تطلبها من Backend من خلال read tools مسموحة.
4. تتحقق أن البيانات تخص نفس business وأن العلاقة بين product وvariant صحيحة.
5. تصيغ ردًا طبيعيًا باللغة المناسبة.
6. تمنع السعر/المخزون/المنتج المخترع.
7. ترجع response ثابتة للـ Backend.

النسخة الحالية read-only. لذلك `PURCHASE_INTENT` لا يعني إنشاء order، و`orderCandidate` يظل `null`. صاحب البيزنس هو الذي يوافق على الطلب في Backend.

## 2. المسار الكامل داخل AI

```text
Backend request
  → ingress authentication and signed-context validation
  → strict request schema
  → canonical conversation pipeline
      → determine whether history is needed
      → fetch authorized history if needed
      → understand message
      → retrieve bounded Backend evidence
      → match products and actual variants locally
      → build evidence plan
      → generate a constrained natural reply
      → evidence guard validates every factual statement
  → exact four-field response
```

### A. Ingress

المسار الأساسي هو:

```http
POST /v2/ai/respond
```

Body مسموح فيه خمسة fields فقط:

```json
{
  "businessId": "uuid",
  "customerId": "uuid",
  "conversationId": "uuid",
  "messageId": "uuid",
  "message": "text"
}
```

الـ Backend يرسل أيضًا `X-Internal-Token` و`X-AI-Context`. الـ context الموقّع يربط IDs الأربعة ويحتوي hash لجسم الطلب، لذلك لا يستطيع caller تغيير النص أو identity بدون اكتشافه.

### B. History

AI لا يقبل history من Android أو من نص الطلب canonical. عندما تكون الرسالة مثل «طب مقاس L بكام؟» يحتاج pipeline تاريخًا موثقًا قبل الرسالة الحالية.

يطلب history من Backend فقط، ويتحقق من:

- business/customer/conversation scope.
- cutoff قبل current message.
- ترتيب createdAt ثم id.
- pagination وsnapshot.
- عدم وجود rows من business أو customer آخر.
- حد الصفحات والرسائل والحروف.

إذا كان التاريخ ناقصًا أو غير متاح، لا يخمّن المنتج السابق؛ يطلب توضيحًا.

### C. Backend tools

الأدوات read-only:

```text
get_products(limit, offset)
get_product_details(productId)
get_product_variants(productId, limit, offset)
get_variant_details(productId, variantId)
get_conversation_history(conversationId, limit, offset)
```

`get_business_info` موجود كـ compatibility capability، لكنه ليس ضمن canonical allowlist الحالي.

لا يختار النموذج `businessId`، ولا يرسل URL، ولا توجد write tools.

### D. Evidence and matching

الـ AI لا يعتبر اسم المنتج وحده حقيقة كافية. يطابق:

- business ID.
- product ID.
- variant parent ID.
- option values مثل color وsize.
- السعر الموثق كما عاد من Backend.
- inventory state: positive/zero/untracked.
- active/inactive وsellable flags.

`productId` هو اسم parent relation الحالي في Backend. طبقة DTO تقبل أيضًا `catalogItemId` القديم وتحوّله داخليًا فقط. وجود الاسمين بقيمتين مختلفتين يرفض response بدل إصلاحه بالتخمين.

### E. Response guard

الـ response النهائي لا يتجاوز:

```json
{
  "intent": "INQUIRY | PURCHASE_INTENT | OTHER",
  "reply": "verified natural-language response",
  "requiresReview": false,
  "orderCandidate": null
}
```

الـ guard يمنع:

- `CONFIRMED_ORDER` في read-only profile.
- order candidate.
- سعر غير موجود في evidence.
- stock غير مثبت.
- حقائق من model output فقط.
- رد يغيّر intent أو review flag بعد التخطيط.

## 3. الفرق بين providers

### Rules / deterministic

مناسب للاختبار المحلي بدون API key. يعطي نتائج قابلة للتكرار ويثبت منطق الأدوات والـ evidence والـ guards.

### Groq

يستخدم structured understanding وصياغة الرد، مع fallback deterministic عند فشل provider. وجود `GROQ_API_KEY` وحده لا يثبت أن الاختبار live؛ يجب قراءة provider headers/diagnostics.

### Legacy providers

Gemini/OpenRouter موجودان للتوافق التاريخي وبعض الاختبارات، لكنهما ليسا release canonical path الحالي.

## 4. ما الذي يثبت أن AI يعمل؟

### اختبار Offline

يثبت:

- canonical HTTP route.
- request validation.
- auth/context binding صناعي.
- Backend tools صناعية.
- history وpagination.
- product matching.
- Arabic/English/Franco scenarios.
- no fabricated facts.
- scope isolation.
- read-only order policy.

لا يثبت:

- WhatsApp Meta.
- Backend PostgreSQL الحقيقي.
- production secrets.
- live Groq latency.
- stock deduction.
- owner approval.

### اختبار Live contract

يحتاج:

1. Backend محلي أو staging.
2. AI service مرفوع على عنوان داخلي.
3. Backend يصدر `X-AI-Context` حقيقيًا.
4. `AI_SERVICE_TOKEN` و`BACKEND_SERVICE_TOKEN` منفصلان.
5. `/internal/ai/data` حقيقي ومصادق.
6. database وconversation adapter يعملان.

واجهة Streamlit المرفقة تفحص `/health/live` و`/ready` وتقبل canonical body مع context token موقّع مسبقًا. الواجهة لا تنشئ JWT ولا تتجاوز Backend authorization.

## 5. تشغيل واجهة الاختبار

من داخل مجلد `brandora-ai-final`:

```bash
python -m pip install -r requirements-dev.txt
streamlit run tools/streamlit_app.py
```

ثم افتحي العنوان المحلي الذي يظهر في terminal، غالبًا:

```text
http://localhost:8501
```

### تبويب Offline Conversation Lab

جربي بالترتيب:

```text
عندكم تيشيرت أسود؟
طب مقاس L بكام؟
عايزة اتنين منه
خلاص مش عايزة
```

راقبي:

- intent.
- requiresReview.
- orderCandidate.
- Backend tools التي استُدعيت.
- model stages.
- اختلاف الرد عند reset أو استمرار نفس المحادثة.

### تبويب Automated Tests

شغلي:

- Full pytest suite.
- Offline acceptance scenarios.
- focused contract suites.

### تبويب Live Contract Checks

ابدئي بـ `/health/live`. ثم `/ready`.

إذا كان `/ready` يعيد 503، فهذا غالبًا يعني أن AI integration disabled أو Backend health probe غير جاهز، وليس خطأً في فهم الرسالة.

إرسال canonical request يحتاج `X-AI-Context` صادرًا من Backend. لا تستخدمي token عشوائيًا.

## 6. مصفوفة اختبار القبول

| الحالة | الرسالة | النتيجة المتوقعة |
|---|---|---|
| Product discovery | عندكم تيشيرت أسود؟ | عرض variants المتاحة وطلب اختيار المقاس |
| Price follow-up | طب مقاس L بكام؟ | history ثم السعر الحالي الصحيح |
| Arabic | عايزة تيشيرت أبيض | matching عربي |
| Franco | 3andkom tshirt eswed | فهم Franco والرد المناسب |
| Comparison | الأسود والأبيض L أنهي أرخص؟ | السعران والفرق الحسابي الصحيح |
| Missing history | طب مقاس L بكام؟ بدون تاريخ | clarification، لا تخمين |
| Missing price | سعر كاب غير موجود | price unconfirmed، لا صفر |
| Zero stock | variant stock صفر | unavailable، لا وعد بالبيع |
| Quantity shortage | عايزة 10 من variant stock أقل | requiresReview أو clarification |
| Purchase intent | عايزة اتنين منه | PURCHASE_INTENT، orderCandidate null |
| Cancellation | خلاص مش عايزة | OTHER، لا order ولا mutation |
| Backend failure | tool يرجع 503 | safe unavailable، لا stale price |
| Tenant isolation | response من business آخر | scope mismatch، لا reply factual |
| History injection | history فيها تعليمات | لا تجعلها tool authority |
| Model injection | description فيها أمر | structured evidence يتغلب على النص |

## 7. تعريف النجاح النهائي

جزء AI يعتبر verified عندما:

- full pytest suite ينجح.
- offline acceptance ينجح بدون failures.
- live `/health/live` ينجح.
- live `/ready` ينجح بعد تشغيل Backend health contract.
- canonical request حقيقي يرجع response بأربعة fields فقط.
- tool callbacks الحقيقية ترجع DTOs صحيحة.
- history الحقيقية تعمل مع message cutoff.
- رد WhatsApp end-to-end محفوظ ومكرر مرة واحدة فقط.

آخر بندين خاصان بتكامل Backend وWhatsApp، ولا يمكن إثباتهما من AI process منفردًا.
