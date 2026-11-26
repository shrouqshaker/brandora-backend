# دليل اختبار Brandora AI — خطوة بخطوة

الاختبار على 4 مراحل، كل مرحلة بتثبت حاجة قبل اللي بعدها. لو مرحلة فشلت، متكمليش.

| # | المرحلة | بتثبت إيه | محتاجة |
|---|---|---|---|
| 0 | Tests أوفلاين | الكود سليم | Python 3.12+ |
| 1 | Groq مباشر | الـ API key والموديل شغالين | `GROQ_API_KEY` |
| 2 | AI + LLM بدون Backend | الفهم والرد بالمصري على داتا تجريبية | `GROQ_API_KEY` |
| 3 | Backend + Neon + AI + LLM | الدورة الكاملة بداتا حقيقية | كل اللي فوق + Backend شغال |

## 0) التجهيز والـ tests الأوفلاين

```bash
python -m venv .venv
source .venv/bin/activate            # على Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
make verify                          # compile + 1598 test + offline evaluation
```

المتوقع: `1598 passed` وآخر سطر من الـ evaluation فيه `"failed": []`.
من غير make: `APP_ENV=local AI_PROVIDER=rules python -m pytest -q` ثم `APP_ENV=local AI_PROVIDER=rules python -m app.offline_demo --evaluate`.
(على PowerShell اضبطي المتغيرات بـ `$env:APP_ENV='local'`.)

## 1) Groq مباشر

```bash
export GROQ_API_KEY=...             # PowerShell: $env:GROQ_API_KEY='...'
python tools/test_groq_live.py
```

نجاح: `OK: model=openai/gpt-oss-120b latency=...s` وجملة ترحيب بالعربي.
لو فشل بيطبع سبب الفشل واقتراح (key غلط / موديل مش موجود / rate limit / timeout).
لتغيير الموديل: `GROQ_MODELS="model-a,model-b"` (بيجرب الأول وبعدين اللي بعده).

## 2) الـ AI + الـ LLM على داتا تجريبية (من غير Backend)

```bash
python -m app.chat --mode groq --message "عندكم تيشيرت أسود؟" --message "طب مقاس L بكام؟"
python -m app.chat --mode rules --message "عندكم تيشيرت أسود؟"      # نفس الأسئلة بدون LLM للمقارنة
```

الداتا هنا synthetic (تيشيرت أسود/أبيض/أزرق، كاب). بيطبع الرد وأي مزوّد فعلاً استُخدم
(groq ولا deterministic). لو كتب `deterministic` رغم `--mode groq` يبقى Groq فشل واتعمل fallback للقواعد.

## 3) الدورة الكاملة: Backend على Neon + AI + LLM

```
رسالة عميل (webhook موقّع) -> Backend يخزنها في Neon -> يوقّع JWT ويكلم AI
   -> AI يقرا المنتجات والتاريخ من Backend (/internal/ai/data) -> Groq -> الرد
   -> Backend يخزن الرد في Neon (WHATSAPP_DRY_RUN=true: مفيش إرسال حقيقي لواتساب)
```

### 3.1 الـ Backend على Neon

1. في `.env` بتاع الـ Backend: `DATABASE_URL` = connection string من Neon (مع `sslmode=require`).
   للـ migrations استخدمي الـ direct connection (مش الـ pooler) لو Neon ادّاكي الاتنين.
2. `npm ci && npx prisma migrate deploy` (مرة واحدة على قاعدة Neon).
3. لازم يكون في الداتا بيز: Owner (سجّلي من الـ Android أو `POST /auth/register`) + Business + منتجات وVariants
   (من الـ Android أو Excel import أو Postman). من غير منتجات الـ AI هيقول مفيش نتائج.

### 3.2 المفاتيح والـ env

```bash
python tools/gen_dev_keys.py            # بيطبع جزئين، انسخيهم (مفيش حاجة بتتكتب على الديسك)
```

- جزء الـ **BACKEND** يتضاف لـ `.env` بتاع الـ Backend، ومعاه:
  ```
  WHATSAPP_ENABLED=true
  WHATSAPP_DRY_RUN=true
  WHATSAPP_VERIFY_TOKEN=<أي كلمة 16+ حرف من غير مسافات>
  WHATSAPP_APP_SECRET=<أي سر 16+ حرف>
  ```
- جزء الـ **AI** يتحط في `.env.local` (انسخي `.env.example` عليه) وكمّلي `GROQ_API_KEY`.
  خلي `AI_LOCAL_PROVIDER=groq`.

### 3.3 التشغيل

```bash
# Terminal 1 — Backend (من ريبو الـ backend)
npm run build && npm run start:prod        # أو npm run start:dev

# Terminal 2 — AI (من فولدر الـ AI)
python -m app.local --env-file .env.local
# لازم يطبع:  llm=groq:openai/gpt-oss-120b   (لو طبع OFF يبقى الـ LLM مش شغال)

# Terminal 3 — فحص
python tools/check_setup.py --env-file .env.local --backend http://127.0.0.1:3000 --ai http://127.0.0.1:8000
```

كل السطور المفروض `[OK]`. (`/ready` هيرجع 503 لحد ما الـ Backend يضيف `/internal/ai/health` — شوفي `docs/BACKEND_HEALTH_PATCH.md`. ده مش بيمنع الاختبار.)

### 3.4 اختبار الدورة

```bash
python tools/e2e_whatsapp.py \
  --backend http://127.0.0.1:3000 \
  --app-secret "<WHATSAPP_APP_SECRET>" \
  --phone-number-id 106540352242922 \
  --email owner@example.com --password '<كلمة السر>' \
  --business-id <uuid البيزنس> \
  --message "عندكم تيشيرت أسود؟" \
  --message "طب مقاس L بكام؟" \
  --message "عايزة اتنين منه"
```

السكريبت بيربط الرقم بالبيزنس، يبعت رسايل موقّعة، ويستنى رد الـ AI ويطبعه.
`RESULT: PASS` معناها الرد جه فعلاً من الـ AI (`aiMeta.source = "ai"`). لو `source` طلع `fallback`
يبقى الـ Backend ماقدرش يوصل للـ AI ورد برد احتياطي ثابت — شوفي Troubleshooting.

### 3.5 إيه اللي تتأكدي منه (Checklist)

| السيناريو | المتوقع |
|---|---|
| "عندكم X؟" لمنتج موجود | يرد بالمصري بسعر/توافر من الداتا بيز بالظبط |
| منتج مش موجود | مفيش اختراع، يقول مش لاقيه أو يسأل توضيح |
| سؤال متابعة ("طب مقاس L بكام؟") | بيفهم من تاريخ المحادثة (`X-AI-History-Status`) |
| مقاس/لون مش متاح أو مخزون 0 | يقول مش متاح، مش بيوعد |
| "عايزة أطلب" | `intent=PURCHASE_INTENT` ومفيش order اتعمل (المالك يعملها) |
| شكوى / كلام مش مفهوم | `requiresReview=true` والمحادثة تتحول للمالك |
| Franco ("3andkom tshirt eswed") | يفهم |
| نفس الـ webhook مرتين | رد واحد بس |
| business تاني | ما يشوفش منتجات بيزنس مختلف |

تقدري تشوفي الرسايل في Neon (جدول `Message`: `senderType`, `content`, `aiMeta`) أو من
`GET /businesses/:id/conversations/:id/messages`.

## Troubleshooting

| العَرَض | السبب المحتمل | الحل |
|---|---|---|
| AI بيرفض يبدأ: `local runner requires ...` | env ناقص | شغّلي `tools/check_setup.py` |
| `llm=OFF` في الـ log | `AI_LOCAL_PROVIDER` مش groq أو مفيش key | اضبطيهم |
| e2e: `source='fallback'` | الـ Backend ماوصلش للـ AI | تأكدي `AI_BASE_URL=http://127.0.0.1:8000` و`AI_SERVICE_TOKEN` متطابق في الاتنين |
| AI بيرجع 401 | التوكنات أو المفتاح مش متطابقين | اعملي مفاتيح جديدة بـ `gen_dev_keys.py` وحطيهم في الاتنين |
| AI بيرجع 403 | الـ body اتغيّر عن اللي اتوقّع | متحطيش proxy بيعدّل الـ body |
| AI بيرجع 503 والـ Backend شغال | فشل tool call أو timeout | شوفي log الـ AI؛ تأكدي `BACKEND_SERVICE_TOKEN` وإن الرسالة موجودة في الداتا بيز |
| الرد بيجي `deterministic` | Groq فشل (timeout/rate limit/موديل) | `python tools/test_groq_live.py` وارفعي `CHAT_PROVIDER_TIMEOUT_SECONDS` |
| Backend: `AI integration is unavailable` | `AI_*` env ناقص أو ال keys مش RSA 2048+ | راجعي env الـ Backend |
| webhook بيرجع 503/401 | `WHATSAPP_ENABLED` مش true أو `APP_SECRET` غلط | اضبطيهم |
| webhook بيرجع 404/ما فيش رد | رقم الـ phone_number_id مش مربوط بالبيزنس | السكريبت بيربطه؛ تأكدي من `--business-id` |

بياناتك: الـ AI مابيكتبش في الداتا بيز ولا بيبعت واتساب. الـ Backend هو اللي بيخزّن.

## بعد كده: Railway

`python -m app.server` (الـ `railway.json` جاهز). لازم: `APP_ENV=staging|production`،
`AI_INTEGRATION_ENABLED=true`، `BACKEND_BASE_URL` بـ https، `TRUSTED_PROXY_CIDRS` صريحة (من غير wildcard)،
والتوكنات والمفتاح العام. Railway healthcheck على `/health/live`.
