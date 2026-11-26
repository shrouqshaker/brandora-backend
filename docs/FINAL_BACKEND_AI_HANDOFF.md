# Backend → AI: on-demand conversation tools

**Verdict: BLOCKED_BY_BACKEND.** AI-owned execution is implemented and verified
offline. No authenticated staging integration has succeeded. All internal tools,
RS256 profiles and new history guarantees below remain proposed Backend work.

## Verified repository state

Read-only review distinguished:

* Backend main: `83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b`. Product/Variant
  controllers use AuthScope and active OWNER/session authentication. Internal
  AI S2S access is not implemented.
* [Conversations PR #1](https://github.com/shrouqshaker/brandora-backend/pull/1):
  open, unmerged; head `0e92d6b5d038aa6da87c76ee5f06d29aebe4127a`.
  Its docs explicitly state no authentication. Its message service filters by
  conversation after a business lookup, orders createdAt DESC/id DESC and returns
  ordinary pagination. It does not establish current-customer authorization or
  a stable before-current snapshot. No public PR endpoint was called.

Sources: [main AuthGuard](https://github.com/shrouqshaker/brandora-backend/blob/83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b/src/auth/auth.guard.ts),
[PR message service](https://github.com/shrouqshaker/brandora-backend/blob/0e92d6b5d038aa6da87c76ee5f06d29aebe4127a/src/conversations/conversations.service.ts),
[PR DTO documentation](https://github.com/shrouqshaker/brandora-backend/blob/0e92d6b5d038aa6da87c76ee5f06d29aebe4127a/docs/conversations-api.md).

## Architecture

```text
Backend persists/authorizes current message → signed HTTPS /v2/ai/respond
 → service/signature/body/identity validation
 → deterministic history-demand decision
 → get_conversation_history only if needed, for this exact conversation
 → strict scope/boundary/snapshot/order/budget checks
 → existing ChatSession restores customer selectors with Python rules
 → existing Product tools obtain fresh current evidence
 → Groq current-turn understanding and grounded natural composition
 → Python fallback + existing evidence Guard → E0-3 → Backend stores/sends
```

FastAPI handles transport/authentication. Python orchestrates tools. Groq does
not execute native function calls, select authorization scope, use arbitrary
URLs or invent IDs/prices/stock. No second conversation engine or production
session registry was introduced. History reconstruction never calls live Groq.
Gemini/OpenRouter remain compatibility modules, not active release providers.

## Canonical request: conversation-tools-v1

**Backend should call `POST /v2/ai/respond`.** Exactly five fields, extra fields
forbidden. `history` and `historyStatus` are neither accepted nor required.

```json
{
  "businessId":"00000001-0000-4000-8000-000000000001",
  "customerId":"00000002-0000-4000-8000-000000000001",
  "conversationId":"00000003-0000-4000-8000-000000000011",
  "messageId":"00000009-0000-4000-8000-000000000003",
  "message":"طب مقاس L بكام؟"
}
```

IDs are canonical UUID strings without unnecessary UUID-version restrictions.
Message is a nonblank trimmed string, maximum2000 characters. Raw ingress is
limited to65,536 bytes/10 seconds. Success keeps E0-3 unchanged, for example with
the synthetic catalog:

```json
{"intent":"INQUIRY","reply":"الأسود مقاس L بـ275 جنيه","requiresReview":false,"orderCandidate":null}
```

Purchases may express PURCHASE_INTENT, never CONFIRMED_ORDER. Orders/reservations
and inventory mutations remain disabled. Response headers include
`X-AI-Contract: conversation-tools-v1` and `X-AI-History-Status`:
not_requested / complete / partial / unavailable. These are non-secret diagnostics.

### Explicit compatibility/migration

The old supplied-history body is a breaking schema change, so old tokens are not
silently reinterpreted as permission to read history:

| Route/profile | Behavior |
| --- | --- |
| `/v2/ai/respond`, conversation-tools-v1 | New five-field body; audience brandora-ai-tools-v1, compound read scope below. Recommended. |
| `/v2/ai/respond-with-context`, supplied-context-v1 | Deprecated, disabled by default; enable SUPPLIED_CONTEXT_COMPAT_ENABLED explicitly. Preserves the previous body with bounded history/historyStatus and audience brandora-ai / products:read. No history tool reads. |
| `/v2/ai/products/respond` | Existing three-field Products-only route/profile unchanged, separately enabled. All45 original tests retained. |
| `/v1/ai/respond` | Legacy compatibility application only; disabled by release launcher. Not the Backend integration target. |

Old clients must either migrate body/token to the new profile, or explicitly
target the gated compatibility route temporarily. That route retains the prior
16-message/12000-character supplied-history limit, ID binding, signature and raw
body hash. Its response is marked supplied-context-v1/Deprecation. A legacy token
cannot call the new canonical route. Products-only tokens cannot gain history
permissions. No auto-routing based on the presence of history is performed.

## When history is requested

`needs_conversation_history` is deterministic and testable. Hard greetings,
thanks, help/escalation, cancellation and pure confirmation do not request it.
A named new product or a substantive unrelated product search does not inherit
old scope or require history. Otherwise option-only changes, requested quantity,
pronouns, implicit price and comparison references can request it, including:

* طب مقاس L بكام؟ / والأبيض؟ / عايزة اتنين منه
* غيرت رأيي، خليها مقاس M / أنهي أرخص؟ / how much is that one?

If context is unavailable, incomplete, ambiguous, outside budget, or has no
unique product reference, the AI clarifies without guessing/product reads.
Authorization/scope rejection returns403. A complete history is reconstructed
oldest-to-newest using existing ChatSession with Python rules only. Prior
comparison alternatives are selectors, not prices; they are retained for an
implicit cheaper question. Only the current turn uses Groq understanding/reply.

Only CUSTOMER TEXT messages restore selectors. AI/OWNER text is never an
instruction or current fact. Unsupported customer media, empty/oversized customer
text and ambiguous customer timestamp ties cause clarification. Historical
prices/stock never supply facts. Reconstructed product IDs/options must still
resolve through fresh scoped Product/Variant evidence, with current effective
prices and inventory caveats. Canonical purchases repeat the current price.

## Authentication — both directions

Backend → AI:

```http
X-Internal-Token: <BACKEND_TO_AI_SERVICE_CREDENTIAL>
X-AI-Context: <BACKEND_ISSUED_RS256_CONTEXT>
Content-Type: application/json
```

AI → Backend:

```http
Authorization: Bearer <DIFFERENT_AI_TO_BACKEND_SERVICE_CREDENTIAL>
X-AI-Context: <ORIGINAL_BACKEND_ISSUED_CONTEXT>
```

Constant-time inbound comparison; separate random >=32-character printable ASCII
credentials; no edge whitespace. Neither is an OWNER JWT or model key. Backend
alone holds the private signing key; AI receives a public RSA PEM >=2048 bits.
No token issuance, dynamic JWKS URL, unsigned claims authorization or OAuth layer
exists in the release service. Backend must independently authenticate and
authorize each internal call, not trust a token merely because AI forwarded it.

New **proposed** canonical context (all fields required except nbf/kid):

| Field | Exact value/requirement |
| --- | --- |
| header alg / typ | RS256 / JWT; optional bounded string kid only. |
| iss | brandora-backend |
| aud | brandora-ai-tools-v1 |
| scope | products:read conversations:read (exact string) |
| businessId/customerId/conversationId/messageId | Must equal canonical request IDs. |
| requestHash | Lowercase SHA-256 hex of exact UTF-8 body bytes transmitted. |
| iat / exp | Integers; iat<=now<exp, lifetime<=300 seconds, zero leeway. |
| nbf | Optional integer, satisfied if present. |

Other claims/header algorithms are rejected. Serialize once, compute hash, sign,
then send those same bytes; reformatting JSON invalidates the binding. Backend
must ensure messageId identifies the persisted current CUSTOMER message for this
business/customer/conversation and that its content matches the authorized body
before issuing context. The token is not a standalone service credential.
Static public-key rotation/revocation needs coordinated Backend agreement.

## Exact internal history tool

Only proposed transport: **POST /internal/ai/data**, with the outbound headers
above. There is no new public conversation endpoint or business-wide listing.

```json
{"tool":"get_conversation_history","arguments":{"conversationId":"00000003-0000-4000-8000-000000000011","limit":20,"offset":0}}
```

messageId/customerId/businessId/snapshot are not arbitrary tool arguments. The
Backend derives them from verified context and the stored current message.
conversationId must equal that context. Proposed successful response:

```json
{
  "tool":"get_conversation_history",
  "data":{
    "businessId":"00000001-0000-4000-8000-000000000001",
    "customerId":"00000002-0000-4000-8000-000000000001",
    "conversationId":"00000003-0000-4000-8000-000000000011",
    "beforeMessageId":"00000009-0000-4000-8000-000000000003",
    "beforeMessageCreatedAt":"2026-10-16T00:00:03.000Z",
    "snapshot":"opaque-stable-context-bound-snapshot",
    "order":"createdAt_desc_id_desc",
    "complete":true,
    "pagination":{"limit":20,"offset":0,"totalCount":2,"hasMore":false,"nextOffset":null},
    "items":[
      {"id":"00000009-0000-4000-8000-000000000002","conversationId":"00000003-0000-4000-8000-000000000011","senderType":"AI","content":"محتاج أنهي مقاس؟","messageType":"TEXT","createdAt":"2026-10-16T00:00:02.000Z","externalMessageId":null},
      {"id":"00000009-0000-4000-8000-000000000001","conversationId":"00000003-0000-4000-8000-000000000011","senderType":"CUSTOMER","content":"عندكم تيشيرت أسود؟","messageType":"TEXT","createdAt":"2026-10-16T00:00:01.000Z","externalMessageId":"synthetic-example"}
    ]
  }
}
```

This deliberately extends the **internal** page beyond the PR DTO. Metadata IDs
are verified against signed scope; each row's conversationId must match. Backend
must derive ownership by authorized DB joins, not simply echo claims around
arbitrary rows. Ordinary PR DTOs alone are insufficient and rejected here.

Messages retain PR fields: id, conversationId, senderType, content, messageType,
createdAt and optional externalMessageId. Known roles: CUSTOMER/AI/OWNER; known
types: TEXT/IMAGE/AUDIO/VIDEO/DOCUMENT/LOCATION/OTHER. Nullable content is allowed
for non-text rows. Raw content limit4096; CUSTOMER reconstruction requires
nonblank TEXT<=2000. Unknown roles/types, missing scope metadata or malformed
fields are invalid. Extra fields in this strict internal history DTO are rejected.

### Ordering, snapshot and completeness guarantees

1. Return newest-first createdAt DESC/id DESC with timezone-qualified timestamps.
   AI validates order across pages, then replays unique customers oldest-first.
2. Exclude the current message and everything after it. beforeMessageId must
   equal signed messageId; beforeMessageCreatedAt must be its stored timestamp.
   Rows at/after that timestamp are ambiguous and not used. Distinct customer
   rows sharing timestamps are conservatively ambiguous despite ID tie-breaking.
3. snapshot is nonblank<=128 characters, stable across all pages of the same
   context/current-message boundary. totalCount/boundary must also remain stable.
   Backend must implement a stable pre-current view (e.g. immutable anchored
   history); unanchored offset pagination over changing data is insufficient.
4. complete=true attests no omitted prior messages in that view. It does not
   mean one page is terminal. Follow pagination until hasMore=false. If Backend
   cannot establish these guarantees, return complete=false rather than a guess.
5. Pagination follows existing limit1..100/default20, safe nonnegative integer
   offset, advancing nextOffset, terminal null. Empty advancing pages are invalid.
   Terminal observed row count must match totalCount. Exact duplicate IDs/records
   are deduplicated; conflicting duplicates are unusable.
6. AI bounds:3 pages,60 messages/records,12000 content characters,5 seconds for
   history; current request has<=12 underlying Backend calls across history and
   products and a default25-second overall deadline. Larger histories exceed
   budget and clarify. No partial selection is restored after a failed page.

These strict history guarantees are **not** retroactively imposed on Product
pagination: existing concurrent-write tolerance and inventory/price protections
remain unchanged. Separate Product reads still are not a global snapshot or
reservation guarantee.

## Products afterward

The same transport still supports only approved Product reads:

| Tool | Arguments |
| --- | --- |
| get_products | limit/default20, offset/default0 |
| get_product_details | productId |
| get_product_variants | productId, limit, offset |
| get_variant_details | productId, variantId |

Use current scoped service DTOs/direct data envelopes, not data.product wrappers.
Money remains authoritative effectivePrice, fixed Decimal(12,2) strings/null;
active flags and real option combinations are enforced. Tracked inventory needs
integer stock>=0, untracked needs null; quantities are observations. EGP is the
existing application currency policy, not a new Backend currency field.
Business-info/list-all-conversations/write tools are not in the canonical allowlist.

## Errors, persistence and delivery

Invalid body400; invalid service/context401; scope/binding/Backend auth failure403;
body size413/read timeout408; whole execution timeout503. History404/5xx/timeout,
invalid JSON, missing/incomplete/ambiguous context return safe clarification with
no guessed product. Product failures never produce invented prices/availability.
Provider failures retain existing strict parsing, circuit/recovery and Python
fallback. No model-native tools or new provider is activated.

Backend persists inbound messages before AI, preserves history ordering, stores
the chosen AI result and delivers once. It must deduplicate/serialize/version
conversation turns and reject conflicting reuse of message IDs. AI is read-only,
may recompute retries and makes no exactly-once-delivery promise. It does not
store messages, send WhatsApp, access conversation tables or process order actions.

## Configuration, deployment and blockers

Unchanged release entry: `python -m app.server`, Railway runtime PORT on0.0.0.0.
railway.json/.python-version remain. Required AI names: APP_ENV,
AI_INTEGRATION_ENABLED, AI_SERVICE_TOKEN, BACKEND_BASE_URL,
BACKEND_SERVICE_TOKEN, BACKEND_CONTEXT_PUBLIC_KEY, TRUSTED_PROXY_CIDRS.
Provider/budget names remain GROQ_API_KEY/GROQ_MODELS,
CHAT_PROVIDER_TIMEOUT_SECONDS/CHAT_TOTAL_TIMEOUT_SECONDS/CHAT_CIRCUIT_SECONDS,
BACKEND_TIMEOUT_SECONDS/INTEGRATION_TIMEOUT_SECONDS. No actual secret values
belong in Git. ENABLE_DEV_ENDPOINTS stays false. Optional compatibility flags
are PRODUCTS_INTEGRATION_ENABLED and SUPPLIED_CONTEXT_COMPAT_ENABLED.

HTTPS remains mandatory in staging/production. Only verified immediate socket
peer CIDRs can assert a single X-Forwarded-Proto:https; arbitrary forwarded IPs,
chains and wildcard trust are rejected. Release launcher disables unconditional
Uvicorn proxy handling and legacy v1. /ready is configuration-only, not proof of
live Backend/Groq acceptance. No Railway/Neon variables or deployments were touched.

Backend must still implement secure internal S2S authentication, agree/issue the
new context profile, independently authorize every scoped read, add the exact
history metadata/snapshot/cutoff guarantees, secure its Conversations work, and
own persistence/idempotency/delivery. A public PR route or OWNER JWT is not a
substitute. Authorized staging must verify the five-field request, tool audit
sequence, scope failures, fresh prices, ordering, snapshot/budget failures,
duplicates, proxy trust and provider quality before complete-system readiness.

## Offline evidence and files

See [independent test plan](AI_INDEPENDENT_TEST_PLAN.md) and saved
[synthetic HTTP results](AI_INDEPENDENT_RESULTS.jsonl).

* Prior conversation-tool milestone: **1,546 passed, 0 failed, 0 skipped**, 2 existing warnings.
* Canonical HTTP suite: 121 cases, including 53 additional cases for this change.
* All 45 original Products integration cases were retained. The subsequent stock
  correction below updates the relevant customer-copy assertion, with stronger
  shortage, review and no-disclosure assertions.
* Independent evaluation: 11 scenarios / 19 HTTP turns, failed=[].
* Existing rules/fake evaluations: 17 turns each, no failed checks.
* Local synthetic server smoke: named inquiry200/not_requested, then
  size follow-up200/complete with fresh275 EGP. No supplied history in either body.

Warnings are Starlette/httpx deprecation and Windows pytest cache permissions.
These results are offline evidence, not authenticated staging acceptance.

This correction modifies conversation orchestration/selection, history schemas
and data access, existing BackendClient allowlist constants, HTTP profile/routing,
configuration, offline Backend storage/demo, canonical tests and current docs.
No second tool framework or conversation engine was created. Actual .env,
working Groq model configuration, Backend repo, Orders and production remain
untouched. Live authenticated integration remains **BLOCKED_BY_BACKEND**.

Changed files: app/conversation_api.py, app/products_api.py, app/chat/application.py,
app/chat/understanding.py, app/clients/backend_client.py, app/data/backend.py,
app/data/history.py, app/schemas/backend.py, app/config.py, app/ingress.py,
app/offline_demo.py, tests/test_canonical_integration.py, .env.example, README.md,
this handoff, AI_INDEPENDENT_TEST_PLAN.md, AI_INDEPENDENT_RESULTS.jsonl and the
current-guide note in PRODUCTS_BACKEND_INTEGRATION.md. No files or tests removed.

## Context correction and customer-facing inventory policy

Confirmed regression: `needs_conversation_history` considered `خلاص` a substantive
new search term and skipped authorized history for the reported fourth turn.
Without replay, `rules_meaning` had no product reference; orchestration correctly
refused speculative retrieval and returned no match before planning/Guard could
help. A second issue was resolving both the new White and superseded Black as
current options. `selection_text` now removes only explicitly superseded known
colors/sizes, never product nouns. Both rules interpretation and option resolution
use it. The original message still reaches Groq as untrusted customer text.
The understanding prompt explicitly distinguishes corrections from comparisons.
Explicit new product anchors still bypass history and replace prior selections.
Quantity, color and size corrections use authorized replay and fresh product /
variant reads. No historical price or stock becomes current evidence.

The shared `NaturalResponder` compiles verified, immutable customer-facing clauses
for both Groq composition and Python fallback. Mandatory shortage warnings cannot
be omitted; review questions are rendered by Python outside model choice. Internal
`VariantFact.recorded_quantity` remains available for audit/validation but default
customer text hides exact inventory. Customer copy avoids database terminology,
duplicated quantities and repetitive no-order disclaimers. This does not change
read-only enforcement: every response still has `orderCandidate=null`.

Stock behavior:

* A uniquely resolved active product/variant with verified options, trusted tracked
  stock and requested quantity greater than stock gets a full-quantity-unavailable
  statement and an offer to review availability with the responsible team.
* This deterministic shortage rule sets `requiresReview=true` and internal
  `ReviewReason.OUT_OF_STOCK_RISK`. It requires SINGLE_VARIANT, no ambiguity,
  no retrieval failure and no limitations beyond ordinary freshness / non-reservation
  notices. Partial, invalid or missing evidence cannot establish this signal.
* Quantity within tracked stock gets cautious final-availability wording, without
  reservation, purchase success or guaranteed availability. `requiresReview=false`
  unless another existing review rule applies.
* Untracked inventory has no stock count and needs availability confirmation.
  Verified zero stock is currently unavailable; there is no promised restock date.
  Invalid inventory evidence is rejected by the existing typed data layer.
* Exact positive stock is disclosed only when the customer explicitly asks for
  quantity AND the authenticated business UUID appears in operator-owned
  `STOCK_QUANTITY_DISCLOSURE_BUSINESSES` (comma-separated; empty by default).
  Model focus, customer body fields and historical text cannot authorize disclosure.
  Counts remain observations with a final-availability caveat. Zero may be conveyed
  naturally as unavailable without a numeric count. Backend/store owners must
  explicitly approve any disclosure policy; the AI does not infer one.

`requiresReview` retains its existing **owner attention / triage** meaning (see
legacy Planner `_apply_owner_flags`, which already uses OUT_OF_STOCK_RISK). It is
neither proof of customer consent to contact someone nor a completed notification,
ticket, reservation or order. Other complaint/review behavior is preserved. The
new shortage flag can be set automatically while the customer-visible escalation
remains an offer. A later affirmative reply must not be treated as proof that an
external action occurred.

Implemented here: read-only evaluation, flag and offer only. **Pending Backend**:
decide whether passive owner-triage display is automatic or consent-gated; persist
the triggering message, reason, customer acceptance/decline and review lifecycle;
authorize any actual escalation; deduplicate by scoped message/action identity;
perform idempotent notification/WhatsApp delivery with retries and delivery status;
and report confirmed action results before the assistant can claim completion.
Backend alone owns fresh inventory validation, order state and reservations.
No notification, review persistence, WhatsApp delivery or write tool was added.
The internal data endpoint and secure authenticated staging integration remain
**BLOCKED_BY_BACKEND**; synthetic evidence is not live acceptance.

Verified corrected synthetic replies:

* Shortage: “تمام، بالنسبة للـ10 قطع من الأسود مقاس L بـ275 جنيه للقطعة،
  والكمية دي مش متاحة بالكامل حاليًا. نراجع إمكانية توفير الكمية مع المسؤول؟”
* Fourth turn: “تمام، بالنسبة للـ3 قطع من الأبيض مقاس L بـ285 جنيه للقطعة،
  والتوافر النهائي محتاج تأكيد”. Intent PURCHASE_INTENT, requiresReview=false.
* Blue/L correction retains the T-shirt and size L, but that variant is inactive
  in the synthetic catalog: no withdrawn 205 price or substitution with Blue/M.

Files changed for this correction: `app/data/search.py`, `app/chat/understanding.py`,
`app/chat/application.py`, `app/chat/natural.py`, `app/pipeline/evidence_planner.py`,
`app/products_api.py`, `app/config.py`, `.env.example`, `app/offline_demo.py`,
`tests/test_customer_stock_regression.py` (new), relevant copy assertions in
`tests/test_products_integration.py`, `tests/test_chat_application.py`,
`tests/test_chat_provider_regressions.py`, `tests/test_multi_provider_development.py`,
this handoff and the three saved JSONL evaluation captures. No unrelated tests,
legacy order logic, real `.env`, authentication or Backend implementation changed.

Permanent regressions cover the exact canonical four-turn flow with valid mocked
Groq and 503/timeout/invalid JSON/semantic/Guard failure paths; quantity/color/size
changes; unrelated cap selection; inactive Blue/L; cancellation; comparison after
purchase; missing/partial history; internal stock evidence; invalid inventory;
disclosure requiring both explicit demand and tenant policy; cross-tenant policy
isolation; and a model attempting to request disclosure without customer demand.

Final verification for this correction (`AI_PROVIDER=rules`,
`ENABLE_DEV_ENDPOINTS=false`, `PYTHON_DOTENV_DISABLED=1`): **1,580 passed,
0 failed, 0 skipped**, 2 warnings (existing Starlette/httpx deprecation and
Windows pytest-cache permission warning). All Products compatibility, canonical
HTTP, history/scope, provider and Guard suites are included. Added 33 permanent
regression cases plus one canonical evaluation scenario; existing cases retained.
Independent HTTP evaluation: **12 scenarios / 23 turns, 0 failed**. Rules and
fake evaluations: **17 turns each, 0 failed checks**. JSONL captures are refreshed.
No live provider/Backend calls, real credential reads, commits or deployments
were performed. Live language quality and secure staging acceptance still require
operator review after Backend prerequisites are met.
