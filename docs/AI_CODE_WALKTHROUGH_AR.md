# شرح كود Brandora AI بالتفصيل

> هذا الملف يشرح النسخة الفعلية الموجودة في `brandora-ai-final`، وليس شرحًا عامًا عن FastAPI أو الشات بوت. أسماء الملفات والدوال والحقول أدناه مأخوذة من الكود نفسه. الهدف أن يكون الملف صالحًا للمذاكرة، ولشرح المشروع في المناقشة، ولتحديد ما الذي تثبته الاختبارات فعلًا.

---

## 1. الفكرة التنفيذية في جملة واحدة

خدمة الـ AI لا تعتبر نفسها نظام الطلبات ولا مخزن المنتجات. هي خدمة **قراءة فقط** تستقبل رسالة عميل ضمن نطاق محدد، تتحقق من هوية الطلب والسياق، تستدعي Backend tools مسموحة لجلب الأدلة الحالية، تبني ردًا deterministic قائمًا على الأدلة، ويمكنها استخدام provider لصياغة الرد، ثم تمرر النص على guard. لذلك لا يجوز أن يكون كلام النموذج مصدرًا للسعر أو المخزون أو تأكيد إنشاء order.

المسار canonical هو:

```text
HTTP request
  → bounded ingress
  → validate X-Internal-Token و X-AI-Context
  → validate request hash / tenant / customer / conversation / message
  → Conversation execution
  → optional history
  → bounded retrieval من Backend tools
  → typed evidence index
  → EvidencePlan
  → deterministic draft
  → optional provider rephrasing
  → guard
  → E0-3 JSON response
```

والنتيجة العامة تكون:

```json
{
  "intent": "INQUIRY|PURCHASE_INTENT|OTHER",
  "reply": "...",
  "requiresReview": false,
  "orderCandidate": null
}
```

في profile الحالي `orderCandidate` يظل `null` دائمًا، ولا توجد عملية حجز أو خصم مخزون داخل Python AI.

---

## 2. خريطة المشروع والتمييز بين المسارين

### 2.1 المسار canonical الجديد

هذا هو المسار الذي يجب اعتباره المرجع عند ربط الخدمة بالـ Backend:

- `app/http.py`: ينشئ تطبيق FastAPI، ويربط routers، ويجهز health/readiness وproviders.
- `app/ingress.py`: يضع حدودًا على body، ويتعامل مع proxy HTTPS، ويحمي canonical route.
- `app/products_api.py`: يحتوي `POST /v2/ai/respond`، ويتحقق من context وrequest binding، ثم يستدعي تنفيذ المحادثة.
- `app/conversation_api.py`: يحضر التاريخ عند الحاجة، ويشغل turn واحدًا، ويرسل الرسالة الحالية فقط للـ AI مع قراءة الرسائل السابقة كمرجع.
- `app/chat/application.py`: يعرّف `ChatSession` و`ConversationPlanner` لمسار المحادثة المحلي/المركب.
- `app/chat/understanding.py`: يحول كلام العميل إلى معنى مضبوط `Meaning`، وليس إلى facts أو صلاحيات.
- `app/pipeline/standalone.py`: المنسق request-local الذي يفرض الحدود ويربط history وretrieval وplanning وgeneration.
- `app/data/retrieval.py`: يبحث في catalog ويجلب التفاصيل والـ variants بحدود زمنية وعددية.
- `app/pipeline/evidence_planner.py`: يحول الأدلة typed إلى `EvidencePlan` وdraft آمن.
- `app/providers/evidence.py` وملفات providers: تصيغ الرد فقط إذا سمح لها الـ plan.
- `app/pipeline/guard.py`: يمنع الأرقام الجديدة، والوعود، وادعاءات قبول الطلب، والروابط، والتنسيق غير المرغوب.

### 2.2 المسار legacy/v1

الملفات التالية ما زالت موجودة للتوافق والاختبارات القديمة أو لمسار request مختلف:

- `app/schemas/request.py` يحتوي نماذج `AIRespondRequest` القديمة وبنية business/catalog/history.
- `app/schemas/internal.py` يحتوي `Intent` التفصيلي و`RouterResult` و`Plan` القديم.
- `app/pipeline/context.py` يبني `Ctx` ويستخرج حالة المحادثة من الرسائل الواردة في الطلب.
- `app/pipeline/planner.py` يحتوي `Planner` القديم، ويكتب ردودًا من `CatalogItem` وFAQ وorders.
- `app/pipeline/orchestrator.py` يحتوي pipeline القديم: hard rules ثم router ثم planner ثم generator ثم guard.
- `app/http.py` قد يربط compatibility routes بالإضافة إلى canonical route.

لا يصح أن نقول إن `Planner` القديم هو الذي ينفذ كل طلب canonical؛ canonical يستخدم `EvidencePlanner` داخل `StandalonePipeline`. لكن الاثنين يشتركان في نفس مبدأ مهم: الـ model ليس صاحب القرار النهائي، والحقائق تأتي من data موثقة.

---

## 3. إنشاء الخدمة من `main.py` و`app/http.py`

نقطة التشغيل تستورد التطبيق أو تستدعي factory الموجودة في `app/http.py`. وظيفة `create_app` العملية هي:

1. قراءة settings من environment.
2. التحقق من configuration، خصوصًا provider وtimeouts وtokens.
3. بناء provider عبر `build_providers`.
4. إنشاء FastAPI app.
5. تسجيل health/readiness وerror handlers.
6. تسجيل routers الخاصة بالـ AI.
7. توفير dependencies اللازمة للـ Backend client والـ conversation execution.

Health لا يثبت أن WhatsApp يعمل. هو يثبت أن process يستجيب. Readiness يضيف معلومات عن provider/configuration، لكنه لا يثبت أن بيانات Backend الحقيقية صالحة لكل business.

---

## 4. HTTP ingress وحدود الأمان

### 4.1 `app/ingress.py`

الـ ingress ليس مجرد route عادي. أهم وظائفه:

- قراءة body بحد أقصى `65536` bytes، حتى لا يستطيع request ضخم استهلاك الذاكرة.
- رفض أو قطع body غير المقبول قبل Pydantic business processing.
- التعامل بحذر مع `X-Forwarded-Proto` أو proxy headers؛ لا يتم اعتبار الطلب HTTPS لمجرد أن العميل كتب header غير موثوق.
- حماية canonical route بحيث لا يمر بدون internal authentication/context المطلوب.

### 4.2 `app/products_api.py`

المسارات المهمة:

- `POST /v2/ai/respond`: canonical endpoint.
- `POST /v2/ai/products/respond`: compatibility route.
- `POST /v2/ai/respond-with-context`: مسار compatibility لا يعمل إلا إذا تم تفعيله صراحة.

في canonical flow يتم ربط الطلب بالـ Backend context عبر عناصر متعددة:

- `X-Internal-Token` لإثبات أن caller داخلي ومسموح.
- `X-AI-Context` وهو context موقّع من Backend.
- RS256 JWT للتحقق من signature وclaims.
- التحقق من tenant/business/customer/conversation/message scope.
- request hash binding: الـ context يحتوي hash لما يجب أن يطابق body الحالي، فلا يمكن إعادة استخدام token مع body مختلف.

الفكرة الأمنية هي أن وجود JWT صحيح وحده لا يكفي؛ يجب أن يكون هذا الـ JWT خاصًا بنفس business/customer/conversation/message والـ request الحالي.

إذا فشل scope أو signature أو hash، فالقاعدة fail-closed: لا يتم تنفيذ retrieval عادي ولا يتم إرجاع معلومات قد تكون من business آخر.

---

## 5. نماذج الطلب والرد

### 5.1 `app/schemas/request.py`

هذا الملف يحتوي نماذج request القديمة/المتوافقة. من القيود المهمة:

- نص رسالة AI لا يتجاوز 2000 code points.
- الحقول business/catalog/history لها validation صارم نسبيًا.
- الرسائل تحمل `id`, `senderType`, `messageType`, `content`, `createdAt`.
- الترتيب الصحيح للـ history يعتمد على timestamp ثم ID عند الحاجة، وليس على UUID كدليل سببي.
- المنتجات inactive لا يجب أن تتحول إلى عروض للعميل.

### 5.2 `app/schemas/backend.py`

هذا هو عقد الأدوات مع Backend. يحتوي typed models للمنتج والـ variant والصفحات والتاريخ و`ExpectedScope` و`RetrievalOutcome`.

يوجد توافق آمن بين `productId` و`catalogItemId`: إذا جاء الاسمان لنفس الكيان فيجب أن تتساوى قيمتهما، والقيم المتعارضة مرفوضة. هذا يمنع أن يتعامل جزء من الكود مع product هو نفسه في الظاهر بينما يكون variant مربوطًا بمنتج آخر.

### 5.3 `app/schemas/inquiry.py`

`Inquiry` هو التمثيل الداخلي للسؤال بعد تطهيره. قد يحتوي:

- `text` الدلالي المستخدم في matching.
- `product_ids` إذا كان المنتج معروفًا من turn سابق.
- `option_values` مثل color/size.
- `option_alternatives` في المقارنات.
- `variant_references` عند وجود reference يحتاج إعادة تحقق.

هذا لا يعني أن IDs التي تأتي من history موثوقة بذاتها؛ هي candidate references فقط وتحتاج revalidation من Backend.

### 5.4 `app/schemas/response.py`

يعرّف contract النهائي E0-3:

- `INQUIRY`: سؤال عادي عن منتج/سعر/توافر/معلومة.
- `PURCHASE_INTENT`: العميل يريد الشراء أو أرسل تفاصيل purchase، لكن لا يعني أن order تم إنشاؤه.
- `OTHER`: greeting أو complaint أو unsupported أو حالات لا تدخل في inquiry/purchase.
- `CONFIRMED_ORDER` موجود للتوافق/النموذج، لكن profile الحالي read-only ولا يخرجه كعملية ناجحة.
- `requiresReview`: يرفع الحالة لصاحب النشاط في الحالات الحرجة مثل payment dispute/legal threat/custom request، وقد يظهر في purchase-risk.
- `orderCandidate`: في النسخة الحالية يجب أن يظل `null`.

Extra fields مرفوضة أو لا تمر في canonical contract، لأن response يجب أن يكون predictable للـ Backend.

---

## 6. `BackendClient`: كيف يصل AI إلى Backend

`app/clients/backend_client.py` هو policy boundary، وليس مجرد `httpx.AsyncClient`.

### 6.1 allowlist للأدوات

العميل لا يسمح باستدعاء arbitrary URL أو arbitrary method. الأدوات المسموحة هي read-only مثل:

- `get_products`
- `get_product_details`
- `get_product_variants`
- `get_variant_details`
- `get_business_info`
- `get_conversation_history`

لا توجد أداة create order أو update stock في المسار الحالي.

### 6.2 validation قبل الإرسال

كل tool argument يمر على validation للـ UUID والـ pagination والـ limit/offset. يتم رفض:

- pagination سلبية أو كبيرة.
- IDs غير صحيحة.
- tool name غير موجود في allowlist.
- scope أو token غير صالح.

### 6.3 قيود النقل

- timeout محدد.
- لا redirects، حتى لا يتحول endpoint المسموح إلى host آخر.
- لا يتم تمرير environment proxy بشكل غير مقصود.
- response bytes محدودة.
- transport exceptions يتم sanitization لها فلا تتسرب تفاصيل داخلية للعميل.

`BackendClient` يعيد `RetrievalOutcome` typed بدل أن يرمي كل شيء للـ pipeline؛ هكذا يستطيع planner معرفة الفرق بين unavailable وauthorization failure وscope mismatch وpartial result.

---

## 7. `BackendDataAccess` وtyped evidence

`app/data/backend.py` يضع طبقة data access التي تستدعي client. أما `EvidencePlanner` فلا يثق في JSON الخام مباشرة؛ يستخدم `_index` ليحوّل envelopes إلى facts typed:

- `ProductFact`: id/business/name/base price/active/sellable/options/source.
- `VariantFact`: product/variant IDs/options/effective price/inventory/active flags/source.
- `EvidenceSource`: اسم tool ورقم envelope والمسار داخل البيانات.
- `GroundedStatement`: جملة مسموحة ومصادرها.

الدالة `_index` تتحقق من أن:

1. كل product وvariant متسق مع business واحد.
2. variant مربوط بنفس `catalogItemId`/product.
3. page يتم validate بالكامل قبل إدخال records.
4. duplicate record أحدث/أكمل observation يستبدل القديم ككل، ولا يتم دمج fields من مصدرين بطريقة قد تنتج record هجينًا.
5. authorization/scope outcome يؤدي إلى رفض، لا إلى استمرار مع بيانات جزئية.

هذه الطبقة هي السبب في أن الرد لا يبنى من نص النموذج، بل من facts لها provenance.

---

## 8. history: كيف تُقرأ المحادثة بدون تسريب أو افتراضات

### 8.1 `app/data/history.py`

القيم الافتراضية:

- `max_pages=3`
- `max_messages=60`
- `max_characters=12000`
- `max_elapsed_seconds=5`
- `page_size=20`

`HistoryService.prepare_authorized` هو المسار الأقوى. يشترط customer وconversation scope، ويطلب التاريخ قبل `current_message_id` من Backend، ويتحقق من snapshot/boundary/order.

الـ history يفرق بين:

- `messages`: رسائل قبل الحالية بترتيب زمني قابل للاستخدام.
- `uncertain_messages`: rows لا يمكن إثبات مكانها زمنيًا.
- `references`: إشارات product/variant مستخرجة من نص قديم.
- `chronology_uncertain`: boolean يذكر أن الترتيب أو الاكتمال غير مضمون.
- `coverage`: complete/partial/unavailable.

مهم جدًا: history لا يعطي صلاحية ولا سعرًا حاليًا. حتى لو وجد النص القديم `productId`، فهو reference يحتاج revalidation من retrieval الحالي.

### 8.2 ترتيب الرسائل

الكود لا يعتمد على UUID لكي يقول إن رسالة سبقت أخرى. يعتمد على timestamp، ويستخدم ID فقط كـ deterministic tie-breaker في العرض/الترتيب. إذا تساوت timestamps أو كان boundary غير واضح، يضع issue مثل `timestamp_tie` أو `uncertain_chronology`، ويفضل clarification بدل اختراع ترتيب.

### 8.3 `app/conversation_api.py`

هذا الملف ينسق conversation request:

1. يتحقق من الحقول الصارمة.
2. يبني request-local cache/budget عبر `RequestProductData`.
3. إذا كانت الرسالة follow-up، يطلب history.
4. يستبعد الرسالة الحالية من التاريخ، حتى لا يرسلها مرتين.
5. يعيد تشغيل رسائل CUSTOMER فقط في المسار المقصود، لا raw assistant prose كأنه حقيقة.
6. يستدعي `execute_conversation` ثم يعيد response canonical.

المبدأ: الرسالة الحالية هي السؤال الذي يجب الرد عليه؛ الرسائل السابقة تساعد في فهم “ده” أو “نفس اللون”، لكنها لا تحل محل fresh Backend facts.

---

## 9. فهم اللغة في `app/chat/understanding.py`

### 9.1 `Meaning`

`Meaning` نموذج Pydantic strict/frozen، ومجاله محدود:

- `act`: product/price/purchase/compare/review/other.
- `product_handle`: مثل `p0` فقط للإشارة إلى product سابق في selection المحلي.
- `search`: كلمات البحث.
- `options`: color/size وغيرها.
- `quantity`: من 1 إلى 10000.
- `language`: ar/en.
- `option_alternatives`: بدائل للمقارنة.
- `focus`: price/stock/availability/comparison/purchase/discovery.
- `script`: native/franco.

### 9.2 `rules_meaning`

هذه الدالة deterministic baseline. تفعل الآتي:

- تطبق routing وN​​LU على النص.
- تميز purchase من كلمات مثل “عايز/عاوز/want/buy”.
- تميز price من “بكام/price/cost”.
- تستخرج color/size/quantity.
- تفهم Franco مثل `eswed`, `abyad`, `azra2`, `etneen`.
- تميز المقارنة، ولا تعتبر سؤال “أي لون أحسن؟” طلب شراء.
- تعرف هل الكلام يشير إلى product سابق أم يسمي منتجًا جديدًا.
- تمنع greeting/thankyou/complaint/payment/legal من التحول إلى product query.

### 9.3 `ConversationInterpreter.understand`

تبدأ validation قبل provider. ثم تبني baseline rules. إذا كان intent محميًا أو escalation فلا تسمح للـ model override.

عند تشغيل provider لفهم الرسالة، prompt يطلب فقط `Meaning JSON`. لا يسمح له باختيار business/customer scope أو tools أو أسعار أو stock أو order actions.

بعد رجوع provider، توجد `validate_selection` التي ترفض:

- handle غير موجود في selection السابقة.
- options فارغة أو غير منطقية.
- إسقاط كمية استخرجتها rules.
- تحويل compare إلى purchase.
- اختراع product name أو search terms لم تظهر في الرسالة.
- تغيير color/size التي طلبها العميل.

ثم تتحول النتيجة إلى `Inquiry` semantic. هذا مهم: model يختار selector دلالي، لكنه لا يصبح authority.

---

## 10. `ChatSession` و`ConversationPlanner`

في `app/chat/application.py`:

### `ChatSession`

- يمثل conversation واحدة بوضوح.
- لا يوجد global registry للـ sessions.
- يستخدم `asyncio.Lock` حتى لا تتسابق turns لنفس session.
- `Selection` المحلية تحفظ candidate/options/quantity كـ hint للسؤال التالي.
- `send` يفهم النص ثم يشغل `StandalonePipeline` مع `prepare_history=False` لأن هذا المسار المحلي يعتمد على selection local.
- بعد retrieval failure يتم مسح selection.
- إذا وجد candidates جديدة يتم تحديث selection.
- إذا قال العميل “لا، خلاص” يتم مسح selection فقط؛ لا ينفذ cancel أو order action.

تعليق الكود مهم: هذا caller-established scope وليس authentication. في production يجب أن يكون scope موثقًا ومخزنًا server-side.

### `ConversationPlanner`

يرث `EvidencePlanner` ويضيف semantic details من `Meaning`:

- اللغة والكمية.
- focus: price/purchase/comparison/stock.
- comparison alternatives.
- reply script native/franco.
- إظهار السعر عند تغير الاختيار أو تغير السعر.
- إذا كان single variant كاملًا ومؤكدًا يزيل clarification العام.
- إذا كانت الكمية المطلوبة أكبر من recorded quantity يضع `OUT_OF_STOCK_RISK` و`requires_review`.

حتى في هذه الحالة لا يوجد reserve ولا order creation.

---

## 11. `RetrievalCoordinator`: الوصول المحدود للبيانات

في `app/data/retrieval.py`:

### الحدود الافتراضية

- `max_calls=8`
- `max_product_pages=3`
- `max_records=100`
- `max_detail_lookups=4`
- `max_elapsed_seconds=5`
- `page_size=10`

### خطوات `retrieve`

1. ينشئ `_Execution` جديدًا لكل request.
2. يحلل route/intents/entities.
3. greeting/thankyou البحتة ترجع `SKIP` دون Backend call.
4. order status/modify/cancel/payment/legal/custom/complaint/returns ترجع `UNSUPPORTED` في read-only retrieval.
5. follow-up يحتاج history؛ إذا لم يوجد، يرجع `CLARIFY`.
6. سؤال اسم النشاط يستدعي `get_business_info`.
7. سؤال product/price/purchase بلا selector يبدأ `_discover` عبر صفحات products.
8. بعد candidate واحد، يطلب product details.
9. عند الحاجة يطلب variants أو variant details.
10. يعيد `RetrievalResult` وفيه evidence والـ coverage والـ counters والـ issues.

### fail-closed

`fail_scope` يمسح products/variants/evidence/cache ويحول coverage إلى unavailable. هذا مهم: عند authorization أو scope mismatch لا نستخدم جزءًا من response ربما جاء قبل اكتشاف المشكلة.

### coverage

- `EXHAUSTED` تعني أن traversal وصل لنهاية الصفحة المتاحة، لا أنها database snapshot ثابتة.
- `PARTIAL` تعني أننا توقفنا مبكرًا أو انتهت budget.
- `UNAVAILABLE` تعني أن المعلومات لا يمكن الاعتماد عليها.

لذلك عدم العثور على منتج في partial search لا يساوي “المنتج غير موجود عالميًا”. الرد الصحيح غالبًا clarification أو unverified.

---

## 12. `EvidencePlanner`: تحويل البيانات إلى قرار آمن

هذا هو قلب canonical read-only.

### 12.1 البداية

`plan(inquiry, result, history)` يستخرج اللغة والـ route، ويحوّل internal intent إلى E0-3:

- create order → `PURCHASE_INTENT`.
- product/price/general info → `INQUIRY`.
- greeting/complaint/unsupported/review → غالبًا `OTHER`.

### 12.2 حالات الفشل أولًا

قبل قراءة products، يعالج:

- authorization failure.
- scope mismatch.
- retrieval inquiry mismatch.
- owner review / complaint.
- greeting/thankyou hard rules.
- help.
- unsupported actions.

### 12.3 `_index`

يفهرس evidence typed ويتأكد من consistency. لو وجد business IDs متناقضة يرجع `SCOPE_MISMATCH` بدل خلط البيانات.

### 12.4 product وvariant resolution

لكل product:

- يسجل identity statement.
- يذكر inactive product على أنه غير قابل للبيع.
- يحل options عبر `resolve_options`.
- يتحقق من variant option metadata.
- يذكر effective price فقط إن كان موجودًا.
- يميز recorded stock عن untracked inventory.
- لا يحول recorded stock إلى reservation.

### 12.5 Resolution

قد تكون:

- `SIMPLE_RESPONSE`
- `BUSINESS_INFO`
- `PRODUCT_AMBIGUITY`
- `SINGLE_VARIANT`
- `MULTIPLE_VARIANTS`
- `NO_MATCH_EXHAUSTED`
- `NO_MATCH_PARTIAL`
- `MISSING_DETAIL`
- `INACTIVE`
- `CLARIFY`
- `UNSUPPORTED`
- `UNAVAILABLE`
- `INVALID`
- `AUTHORIZATION_FAILED`
- `SCOPE_MISMATCH`

`selected_variant_id` لا يتم وضعه إلا إذا كان هناك variant واحد مناسب، active، سعره معروف، والمخزون المسجل موجب، ولا توجد clarification أو missing facts.

### 12.6 limitation المقصود

الـ plan يضع دائمًا تقريبًا:

- `recorded_observations_not_reservations`
- `no_stable_snapshot`

وقد يضيف `partial_catalog_not_globally_unique` أو `variant_search_incomplete` أو `provisional_history`. هذه ليست debugging فقط؛ هي قيود يجب أن تؤثر في صياغة الرد.

---

## 13. `StandalonePipeline.execute`: الترتيب الفعلي للطلب

في `app/pipeline/standalone.py`:

1. ينشئ `TurnBinding` من scope/message/products_only.
2. يعيد validate نسخة detached من `Inquiry`.
3. يتحقق من `context_token`.
4. ينشئ `_RequestData` بdeadline وcounter موحد لكل Backend call.
5. يحضر history إذا كان السؤال contextual follow-up.
6. ينفذ retrieval بنفس scope/token.
7. إذا اكتشف authorization/scope failure يعيد plan آمنًا.
8. يمرر inquiry وretrieval وhistory إلى planner.
9. إذا تغير inquiry بين retrieval والـ plan، يرفضه بدل الرد على سؤال مختلف.
10. يستدعي generator.
11. يvalidate `AiResponse`.
12. يرفض generation الذي يضيف orderCandidate أو CONFIRMED_ORDER أو يغير intent/requiresReview.
13. عند timeout أو invalid generation يستخدم generator fallback.
14. يعيد `StandaloneExecutionResult` وفيه response وhistory/retrieval/plan/generation/diagnostics.

الحد العام للـ execution الافتراضي 20 ثانية و12 Backend calls، بالإضافة إلى limits الداخلية للتاريخ والـ retrieval.

---

## 14. Providers

### 14.1 `app/providers/__init__.py`

`build_providers` يقرأ `AI_PROVIDER`:

- `rules`: يبني `RulesRouter` كـ router وfallback، ولا يحتاج API key، وgenerator يكون deterministic/غير شبكي حسب assembly.
- `gemini`: يبني `GeminiClient` و`GeminiRouter`، ويستخدم `RulesRouter` كـ fallback، وgenerator اختياري حسب `generator_enabled`.
- قيمة أخرى ترفع `ConfigError`.

النسخة الحالية من factory تعرض Gemini كمسار provider الأساسي الاختياري. توجد ملفات compatibility لمزودين متوافقين مع Groq/OpenRouter/Gemini في أجزاء أخرى، لكن لا يجب افتراض أن كل ملف يتم اختياره في canonical flow؛ الاختيار النهائي تحدده settings وfactory وroute.

### 14.2 `RulesRouter`

في `app/providers/rules.py`، يبني `RuleContext` من المنتجات النشطة وحالة المحادثة وFAQ، ثم يستدعي `classify_rules`. لا network ولا key.

هذا ليس mock فقط؛ هو safety net عند سقوط provider، وهو وضع offline قابل للتكرار.

### 14.3 Generator

وظيفة generator هي إعادة صياغة draft لا اختراع facts. إذا فشل provider أو أعاد JSON غير صالح، يعود إلى draft deterministic.

---

## 15. `app/pipeline/guard.py`: آخر حاجز قبل العميل

`check_reply(reply, plan, language)` يعيد قائمة مشاكل. عند وجود أي مشكلة، orchestrator يتخلص من generated text ويرسل template draft.

الفحوصات الفعلية:

- الرد غير فارغ.
- لا أرقام جديدة غير موجودة في draft.
- لا يسقط أسماء products في `protected_terms`.
- يمنع phrases مثل “تم تأكيد طلبك”، “تم تسجيل طلبك”، “order confirmed”، ووعود refund/cancel/notify owner.
- يحافظ على marker الخاص بسؤال confirmation أو clarification أو cancel/modify.
- يمنع URL.
- يمنع Markdown/bullets حسب السياسة.
- يمنع emoji.
- يضع حدًا لطول الرد.
- يتحقق من اللغة.
- يحافظ على question mark إذا كان draft سؤالًا.

المعنى العملي: حتى لو provider hallucinated سعرًا أو كتب “طلبك اتأكد”، لن يصل النص للعميل.

---

## 16. `app/pipeline/context.py` و`app/pipeline/planner.py` في المسار القديم

### `build_context`

يبني `Ctx` من legacy request:

- ينقي catalog إلى active products فقط.
- يزيل الرسالة الحالية إذا كانت موجودة آخر conversation.
- يرتب history زمنيًا.
- يحدد `awaiting_confirm`, `mid_order`, `pending_action` من آخر outbound message.
- يحدد `active_orders` من statuses مثل `PENDING`, `PENDING_APPROVAL`, `IN_PROGRESS`.
- يحدد `is_angry_customer` من payment dispute/legal threat الأخيرة.
- يجهز FAQ بحد أقصى 40.

### `Planner`

يأخذ `RouterResult` ثم:

1. يرفض confidence المنخفض ويحوّل intent إلى UNKNOWN.
2. يستخرج slots: quantity/color/size/time/order reference/max price.
3. يطابق product بطريقتين: model query وdeterministic text matching.
4. يطبق FAQ override إذا كانت الإجابة موجودة عند صاحب النشاط.
5. يبني reply للـ product/price/general info/order status/complaint/help/order changes.
6. في create order يتحقق من active/inventory/options/missing details.
7. لا يعتبر customer confirmation تنفيذًا فعليًا وحده؛ confirmation ينتج candidate فقط في legacy semantics، بينما canonical الحالي read-only.

في حالة customer غاضب، يوقف sales push ويستخدم careful mode.

---

## 17. `app/pipeline/orchestrator.py`: hard rules → router → planner → generator → guard

هذا الملف مهم للمناقشة لأنه يوضح الشكل العام للـ AI pipeline القديم:

1. hard rules لـ greeting/thanks/confirmation/decline.
2. router يختار internal intent.
3. router fallback إلى rules عند فشل provider.
4. sanitization لنتيجة model.
5. planner يبني draft من catalog/FAQ/history/orders.
6. generator قد يصيغ draft بلغة طبيعية.
7. guard يفحص النص.
8. عند فشل guard يرجع draft deterministic.
9. يبنى E0-3 response.

الأجزاء المشتركة مع canonical هي الفكرة الأمنية، لكن تفاصيل البيانات مختلفة: orchestrator القديم يعتمد `Ctx` و`CatalogItem`، بينما canonical يعتمد `RetrievalResult` وtyped evidence.

---

## 18. أمثلة فعلية لمسار رسائل

### مثال 1: سؤال سعر

الرسالة: `بكام المنتج X؟`

1. ingress يتحقق من الحجم.
2. products API يتحقق من token/context/hash/scope.
3. `ConversationInterpreter` أو router يحدد price inquiry.
4. retrieval يبحث عن X، ثم product details، وربما variants.
5. planner لا يأخذ السعر من النموذج؛ يأخذه من `effectivePrice` أو `basePrice` في evidence.
6. draft يذكر السعر المؤكد فقط.
7. generator إن وجد يعيد الصياغة.
8. guard يمنع أي رقم جديد.
9. response intent = `INQUIRY`.

### مثال 2: متابعة “نفس اللون، مقاس L”

1. deterministic cues في `is_contextual_followup` تكتشف أن الرسالة لا تحتوي product name كاملًا.
2. HistoryService يطلب الرسائل السابقة قبل current message.
3. history يعطي reference فقط.
4. retrieval يعيد جلب product/variants من Backend.
5. option resolver يطابق اللون والمقاس.
6. إذا variant واحد verified يكون resolution `SINGLE_VARIANT`؛ إن كان هناك غموض يرجع clarification.
7. لا يتم اعتبار السعر القديم أو نص AI القديم حقيقة حالية.

### مثال 3: “عايزة أطلب 5 قطع”

1. intent داخلي = create order/purchase.
2. quantity تستخرج deterministic وتظل جزءًا من الطلب.
3. retrieval يتحقق من product/variant/current recorded quantity.
4. إذا quantity أكبر من المسجل، `OUT_OF_STOCK_RISK` و`requiresReview`.
5. إذا كل شيء متاح، النتيجة `PURCHASE_INTENT`، وليس `CONFIRMED_ORDER`.
6. `orderCandidate` يظل `null` في profile الحالي.

### مثال 4: شكوى دفع أو تهديد قانوني

1. hard rules تحمي هذا النوع من model override.
2. لا يتم استدعاء product retrieval غير المطلوب.
3. response intent = `OTHER` و`requiresReview=true` عند الحالات المالكة للمراجعة.
4. reply ثابت/حذر، ولا يدعي أن الشكوى تم تحويلها أو أن refund تم.

### مثال 5: منتج غير موجود أثناء partial catalog search

إذا انتهت budget أو توقف traversal قبل نهاية catalog، coverage = `PARTIAL`. الرد لا يقول “غير موجود في المتجر” كحقيقة عالمية؛ يقول إنه لم يتم التحقق أو يطلب توضيحًا.

---

## 19. الاختبارات: ماذا تثبت وماذا لا تثبت؟

النتيجة الأخيرة المذكورة للنسخة هي `1598 passed`.

### 19.1 security tests

تختبر عادة:

- invalid/missing internal token.
- JWT signature/algorithm/expiry/claims.
- request hash mismatch.
- tenant/customer/conversation/message mismatch.
- منع cross-business history/product evidence.
- tool allowlist والـ argument validation.
- عدم تمرير redirects/proxies غير مقصودة.
- sanitized errors.

هذه تثبت أن منطق policy المحلي يرفض الحالات الخطرة، لا أنها تثبت إعداد secrets الحقيقي في production.

### 19.2 contract/schema tests

تختبر:

- قبول request الصحيح.
- رفض message أكبر من 2000.
- رفض response extra fields أو invalid intent/order candidate.
- توافق `productId/catalogItemId` ورفض التعارض.
- pagination وUUID وtimestamps والـ enums.

### 19.3 retrieval/history tests

تختبر:

- pagination وlimits.
- cache داخل request.
- product/variant matching.
- partial coverage.
- timeout/call/record/detail limits.
- history boundary قبل current message.
- timestamp ordering وties.
- replay/reference وعدم استخدام النص التاريخي كـ current fact.

### 19.4 integration tests

باستخدام FastAPI `TestClient` و`httpx.MockTransport`، تثبت أن المكونات تتصل ببعضها offline بعقود fake Backend. هذا قوي جدًا لاختبار flow، لكنه لا يثبت أن live Backend يرجع نفس payload في production.

### 19.5 ما لا تثبته الاختبارات offline

لا يجوز الادعاء أن `1598 passed` تثبت:

- WhatsApp webhook الحقيقي.
- إرسال reply إلى WhatsApp provider.
- صلاحية production JWT keys/secrets.
- صحة URL أو deployment network الفعلي.
- أن Backend live يطبق نفس pagination/order/snapshot contract.
- الخصم الفعلي للمخزون بعد تأكيد order.

لإثبات end-to-end نحتاج بيئة integration حقيقية: Backend deployed، secrets/key rotation، webhook/WhatsApp sandbox، request حقيقي، ثم trace من save customer message إلى save AI reply إلى send WhatsApp reply. هذا خارج إثبات offline الحالي.

---

## 20. Streamlit console

الملف:

```text
tools/streamlit_app.py
```

وظيفته local test console وليس production UI. يستخدم في:

- تشغيل محادثة offline مع `AI_PROVIDER=rules`.
- رؤية response والـ diagnostics.
- عرض tools/candidates/matching variants/selected variant.
- تشغيل test suite.
- health/contract checks.

تشغيله من مجلد المشروع:

```bash
cd /home/ubuntu/projects/brandora-3b1908bf/brandora-ai-final
APP_ENV=local AI_PROVIDER=rules streamlit run tools/streamlit_app.py
```

تشغيل service/health حسب ملفات المشروع:

```bash
APP_ENV=local AI_PROVIDER=rules uvicorn main:app --host 0.0.0.0 --port 8000
```

استخدمه لإثبات behavior offline، لا لادعاء أن WhatsApp أو Backend live متصلان.

---

## 21. أوامر التحقق النهائية

```bash
cd /home/ubuntu/projects/brandora-3b1908bf/brandora-ai-final
python3 -m compileall -q app main.py tools/streamlit_app.py
APP_ENV=local AI_PROVIDER=rules python3 -m pytest -q
```

وللتأكد من contract يدويًا:

1. شغل الخدمة على local.
2. نفذ health endpoint.
3. نفذ request canonical صحيحًا باستخدام test fixtures/headers المعتمدة.
4. جرّب request hash أو scope خاطئًا وتأكد من الرفض.
5. جرّب price/product/follow-up/purchase-intent/complaint.
6. راقب diagnostics، خصوصًا `backendCalls`, `coverage`, `resolution`, `fallback`, `replyFailure`.

---

## 22. خلاصة للمناقشة

إذا سُئلت: “أين الذكاء الاصطناعي هنا؟” فالإجابة الدقيقة هي:

- model/provider يساعد في interpretation أو rephrasing عند تفعيله.
- لكن safety-critical decisions deterministic وtyped.
- Backend هو مصدر المنتجات والأسعار والمخزون والتاريخ.
- retrieval محدود ومربوط بالـ scope/token.
- planner يحول evidence إلى plan.
- generator لا يضيف facts.
- guard يمنع hallucination وorder claims.
- response contract ثابت.
- الـ AI الحالي read-only؛ لا ينشئ order ولا يخصم stock.

وإذا سُئلت: “هل المشروع انتهى بمجرد نجاح الاختبارات؟” فالإجابة: جزء AI مثبت offline بدرجة قوية، لكن live Backend وWhatsApp وproduction deployment يحتاجون integration/E2E منفصلًا. هذه ليست ثغرة في claim؛ بل فصل صحيح بين contract proof وproduction proof.
