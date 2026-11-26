# Railway: إيه المتجهز وإيه لسه ما اتثبتش؟

تاريخ audit: 2026-11-04. **ما دخلناش Railway account أو project ، وما اتعملش deploy/build/network probe. وجود deployment فعلًا UNVERIFIED.** الملف ده خطة تشغيل ومراجعة، مش إعلان إن التطبيق منشور.

## 1. دليل الإعداد الموجود في الريبو

| File / function | الموجود فعلًا | اللي مش بيثبته |
|---|---|---|
| [railway.json](../railway.json) | builder RAILPACK ، startCommand `python -m app.server`، healthcheck `/ready` timeout60 ، ON_FAILURE max3 | إن build نجح أو service موجودة في حساب Railway |
| [.python-version](../.python-version) | `3.13` | minor/patch اللي Railway هينزله فعلًا أو نجاح clean install |
| [requirements.txt](../requirements.txt) | FastAPI/Uvicorn/google-genai/Pydantic/dotenv/httpx/google-auth[cryptography] بـ version ranges | lockfile reproducibility ؛ comments القديمة مش actual environment manifest |
| [app/server.py:create_application](../app/server.py) line9 | APP_ENV staging/production ، canonical enabled ، trusted proxy CIDRs ، dev endpoints مقفولة | Backend reachable أو provider configured/live |
| `app/server.py:main` line24 | PORT valid1..65535 default8080 ، host0.0.0.0 ، proxy_headers=False ، access_log=False ، keepalive5 ، concurrency64 | edge/proxyCIDRs صحيحة تحت Railway أو قدرة تحمل production |
| [app/ingress.py:IntegrationIngress](../app/ingress.py) | bounded body/read timeout ، bounded trusted socket-peer CIDRs | إن X-Forwarded-Proto جاي من proxy موثوق فعلًا من غير معرفة edge |
| [app/http.py:create_app](../app/http.py) | /health/live process-only، و/ready ينفذ Backend health GET محدودًا ومصادقًا عند تفعيل canonical | لا يثبت ذلك hosted deployment أو provider/Groq live |

مقتطف deployment فعلي:

```json
"deploy": {
  "startCommand": "python -m app.server",
  "healthcheckPath": "/ready",
  "healthcheckTimeout": 60,
  "restartPolicyType": "ON_FAILURE",
  "restartPolicyMaxRetries": 3
}
```

مقتطف launcher فعلي:

```python
return create_app(replace(settings,ai_provider="rules",legacy_api_enabled=False,enable_dev_endpoints=False))
```

ده بيقفل legacy providers/routes في release. `ai_provider="rules"` هنا **مش معناه canonical Groq مقفول**؛ canonical بيبني GroqClient مستقل في `app/products_api.py:build_products_router`. ما تستخدمش `uvicorn main:app` كبديل release من غير review ؛ `main.py` wrapper يقدر يفعّل v1 compatibility حسب config.

## 2. readiness endpoint مش شهادة ربط

`GET /health/live` يرجع `{"status":"ok"}`. عند `AI_INTEGRATION_ENABLED=true`، `GET /ready` ينفذ طلبًا واحدًا bounded إلى `BACKEND_BASE_URL/internal/ai/health` باستخدام `Authorization: Bearer BACKEND_SERVICE_TOKEN` فقط، بلا `X-AI-Context`، وبـ`trust_env=false` وبدون redirects. يقبل فقط JSON exact هو:

```json
{"status":"ready","database":"up","contract":"conversation-tools-v1"}
```

نجاح probe يرجع 200 مع `backendLiveVerified=true` و`providerLiveVerified=false` و`ordersEnabled=false`. الفشل (disabled أو auth/timeout/oversize/invalid contract/unavailable) يرجع 503 ولا يعلن Backend حيًا. `DEPENDENCY_READINESS_FILE` retained كـoperator attestation منفصل فقط ولا يمكنه إخفاء probe فاشل. `/health` متعلق provider container؛ في release هي rules، وليس مؤشرًا لصحة canonical Groq. لا تستخدم health `?probe=true` في بيئة مجهولة لأن legacy compatibility قد يكون لها live probe.

## 3. Environment variable checklist

مفيش real secrets في الجدول، وما فتحناش `.env`. values الحساسة يضعها operator في secret configuration بعد موافقة، مش في Git ولا transcript.

| Variable | لازم؟ / القيمة المستهدفة | مين يوفرها؟ / سببها |
|---|---|---|
| `APP_ENV` | لازم `staging` لأول بيئة | release يرفض local |
| `AI_INTEGRATION_ENABLED` | لازم `true` | canonical route + /ready |
| `AI_PROVIDER` | اختار `rules` بوضوح | legacy Gemini مش محتاج key في release ؛ launcher يفرض rules |
| `ENABLE_DEV_ENDPOINTS` | لازم `false` | launcher يرفض true |
| `LEGACY_API_ENABLED` | `false` واضح؛ launcher يفرضها | منع v1 في release |
| `AI_SERVICE_TOKEN` | لازم secret printableASCII≥32 ، بدون surrounding whitespace | Backend→AI ؛ مختلف عن outbound |
| `BACKEND_SERVICE_TOKEN` | لازم secret منفصل بنفس minimum | AI→Backend dispatcher ؛ Backend لازم يقبله فعليًا |
| `BACKEND_BASE_URL` | لازم HTTPS origin بدون path/query/userinfo | مش عنوان publicCRUD ؛ Backend داخلهيوفر /internal/ai/data |
| `BACKEND_CONTEXT_PUBLIC_KEY` | لازم RSAPublicKey≥2048 PEM ؛ loader يفهم literal `\n` | public half للـ Backend issuer ؛ privatekey في Backend فقط |
| `TRUSTED_PROXY_CIDRS` | لازم list غيرفاضية من explicit verifiedCIDRs | operator يتحققمن immediate socketpeer ؛ لا`*` ولا 0.0.0.0/0 ولا::/0 |
| `GROQ_API_KEY` | مطلوب لهدف liveGroq ؛ runtime يسمح fallback بدونه | operatorsecret ؛ ما نختبروشفي audit |
| `GROQ_MODELS` | config الحالي `openai/gpt-oss-120b` | ده ID الموجودفيالكود؛ availability/quota تتراجعوقتاختبار operator |
| `CHAT_PROVIDER_TIMEOUT_SECONDS` | default3 | perHTTPprovider attempt |
| `CHAT_TOTAL_TIMEOUT_SECONDS` | default8 | stage budget ؛ understanding/reply لكل stage |
| `CHAT_CIRCUIT_SECONDS` | default30 | provider health cooldown/recovery |
| `BACKEND_TIMEOUT_SECONDS` | default5 | perrequest Backend timeout ،لا retry تلقائي |
| `BACKEND_MAX_RESPONSE_BYTES` | default1048576 | حد streaming قبل JSON parsing؛ Content-Length المفقود يُقرأ bounded والخاطئ يُرفض |
| `DEPENDENCY_READINESS_FILE` | optional؛ attestation منفصل لا يكفي للجاهزية | لا يستبدل Backend health probe ولا يثبت hosted deployment |
| `INTEGRATION_TIMEOUT_SECONDS` | default25 ، لازم positive≤60 | canonical end-to-end deadline |
| `PRODUCTS_INTEGRATION_ENABLED` | optional ، false لو compat مشمطلوب | يضيف /v2/ai/products/respond فقط |
| `SUPPLIED_CONTEXT_COMPAT_ENABLED` | defaultfalse ،خليها false | يمنع deprecatedsupplied-historyroute |
| `STOCK_QUANTITY_DISCLOSURE_BUSINESSES` | defaultblank | operator-approved businessUUIDallowlist ؛ explicitcustomerquestion شرطثاني |
| `PORT` | Railway runtime value ؛ launcherfallback8080 | متثبتوش على localport بالغلط |
| `LOG_LEVEL` | defaultINFO | لا secrets/rawcustomerpayloads ؛راجع logs قبل release |

`CHAT_PROVIDER_ORDER`/OpenRouter/Gemini historical CLI config **مش بيغير canonical ProviderChain** الحالي؛ canonical Groq ثم deterministic fallback. مفيش احتياج ل Gemini أو OpenRouter key عشان release الحالي. Python AI مش محتاج `DATABASE_URL` ولا Neoncredentials ؛ Backend هواللييملك DB والـ Prisma.

القيمالنهائية لل timeout/limits وقدرةالتحمل تتراجعحسب staging ؛ passingunit tests مش load test. Ingress65536bytes/10sec ، canonical12Backendreadscap ، response byte cap، retrieval/historybudgetsm حدودة، uvicornconcurrency64 ؛ oversize/slow requests لازم تتراجععبر edge الحقيقي.

## 4. اللي اتختبر هنا واللي ما اتختبرش

**اتنفذ offline:** full suite فيها 1580 passed، مفيش failures أو skips، وwarning واحدة تخص Starlette/httpx. independent HTTP evaluation: 12 سيناريو و23 رسالة. rules/fake: 17 رسالة لكل واحد. واتعاد interactive four-turn scenario.

`tests/test_canonical_integration.py` بيختبر startup يرفض config ناقصة، PORT، قفل legacy، proxy spoofing، body/deadlines، وauth/history scopes بالمحاكاة. اختبار launcher بيحقن config وبيعمل mock لـ `uvicorn.run`؛ مش process شغال على Railway.

**ما اتنفذش:** clean install، Railpack build، container image، إنشاء resources، deployment، health عبر public edge، real Backend/S2S، live Groq، Neon query، WhatsApp، load/soak/recovery tests. Backend source اتقري GitHub بس؛ tests بتاعته ما اتشغلتش.

الموجود يسمح نبدأ **تخطيط staging**. configuration مش كاملة لقبول التكامل: issuer/receiver، secrets، proxy CIDRs والـbuild الحقيقي محتاجين دليل operator. ما نستنتجش deployment من ملف config أو readiness mock 200.

## 5. blockers قبل real integration

1. Backend main عنده Products/Variants، لكن مفيهوش `/internal/ai/data` أو AI S2S verifier/context issuer. OWNER JWT مش بديل.
2. Conversations PR #1 غير merged، ومفيهوش auth الحالية أو history snapshot/cutoff canonical. لازم secure merge ومراجعة DTO.
3. Backend caller لازم يستخرج trusted IDs، يحفظ current message، ويوقّع raw-body hash؛ tools تتحقق من authority مستقلًا.
4. مطلوب history snapshot ثابت عبر pagination، بحد current message وcustomer/conversation ownership مثبتة.
5. reply/review persistence وdedup/delivery/consent policy ناقصين للـcustomer-facing flow. Orders تفضل disabled.
6. حساب Railway/project/proxy trust والـbuild الحقيقي مش متراجع في المهمة دي.

التفاصيل في [Backend checklist](BRANDORA_BACKEND_IMPLEMENTATION_CHECKLIST.md).

## 6. خطة staging آمنة — مستقبلية، لم تُنفذ

### قبل النشر

1. operator يحدد project/service/region، ويتأكد إنها staging منفصلة عن Production. استخدم synthetic tenant مستقل، من غير بيانات عملاء حقيقية.
2. Backend team ينفذ ويختبر P0 blockers؛ يجهز staging HTTPS origin وcredentials منفصلة وRSA issuer/public key وعقد claims.
3. راجع source المراد نشره: فيه ملفات أساسية untracked؛ Git commit القديم مش هيتضمنها. هنا مفيش commit/push؛ اختيار reviewed source version خطوة operator لاحقة.
4. شغّل offline commands في [Testing handbook](BRANDORA_AI_TESTING_HANDBOOK.md). اعمل clean dependency build في مساحة معزولة بعد الموافقة؛ تأكد من Python 3.13 والـversions الفعلية؛ requirements ranges مش lockfile.
5. تحقق من Railway edge/immediate proxy CIDRs بمصدر موثوق. استخدم أضيق ranges صحيحة؛ ما تختارش private CIDR عشوائي عشان startup ينجح.
6. حط variables عبر secret settings. لا تطبع `.env` أو private keys/headers. خلي dev/legacy/supplied-context disabled إلا بقرار صريح.
7. النشر لاحقًا يستخدم `railway.json` والـreviewed source. Dashboard/CLI اختيار operator؛ المراجعة دي ما أنشأتش resources وما شغلتش deploy.

### بعد النشر، قبل customer data

الأوامر دي **للمستقبل ومش اتشغلت هنا**. operator يحط URL staging حقيقي ومتراجع؛ health requests بس ومن غير keys:

```powershell
$aiStagingOrigin = 'https://<operator-approved-staging-host>'
Invoke-RestMethod -Uri "$aiStagingOrigin/health/live" -Method Get
Invoke-RestMethod -Uri "$aiStagingOrigin/ready" -Method Get
```

ما تنفذهاش قبل تبديل placeholder. المتوقع live ok وready configured مع backendLiveVerified=false؛ ده لسه مش integration test. بعد كده جرب synthetic owned tenant من Backend caller اللي بيصدر signed context؛ ما نكتبش fake JWT يدوي أو نشارك المفاتيح.

راجع الحاجات دي بالترتيب:

- startup logs بدون secrets، host 0.0.0.0 وPORT صح، v1/dev مقفولين، وcompat flags حسب الموافقة.
- HTTPS عبر edge؛ wrong peer/spoofed header/wrong body hash/expired token/wrong IDs يترفضوا.
- greeting بلا tools؛ named product بلا history؛ follow-up بـauthorized history؛ الأربع turns تنتهي White/L 285 وquantity 3.
- actual tools وDTO، Decimal/null/stock policy، cross-business/customer رفض، history boundaries والـduplicates صح.
- Groq understanding/reply مستخدمين فعلًا؛ latency/quota/fallback متراجعين من غير تخفيف Guard. rules reply ناجح لوحده مش دليل live Groq.
- review offer ما يدعيش notification؛ orderCandidate=null دائمًا؛ لا Orders أو inventory mutations.
- لما Backend workflow يتوفر: persistence/outbox/delivery retries؛ duplicate external message ما يكررش reply/action.
- failure/restart/timeout checks على staging فقط، وقياس concurrency، وبعدها مراجعة بشرية للغة والبيع.

لو فيه auth/snapshot/DTO mismatch، وقف acceptance وسجّل sanitized failure. ما تفتحش permissions أو تلغي Guard عشان التجربة تكمل. rollback لآخر reviewed staging version/config قرار operator؛ مفيش تغيير Production في audit.

## 7. قرار الجاهزية

**Prepared source/config + MOCK-TESTED startup، لكن live integration BLOCKED، deployment UNVERIFIED.** Production readiness لسه غير مثبتة. Orders وWhatsApp/review delivery مش مكتملين. live Groq success اللي اتبلغ عنه قبل كده historical operator report؛ ما أعدناهوش هنا ومش بديل end-to-end staging acceptance.
