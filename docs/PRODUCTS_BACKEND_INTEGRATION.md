# Products integration: AI-side preparation and Backend handoff

For the current canonical conversation-tool contract, use
[FINAL_BACKEND_AI_HANDOFF.md](FINAL_BACKEND_AI_HANDOFF.md). This document retains
the completed Products-only route/profile; it does not authorize history reads.

Status: **AI HTTP assembly implemented and tested offline; real integration is
not operational or staging-verified.** Products integration is disabled by
default. Backend's internal endpoint and context issuance remain proposed work.
No Conversations, Orders, WhatsApp, database migration or deployment is included.

## Audit and reference revision

Backend `main` was reviewed at
[`83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b`](https://github.com/shrouqshaker/brandora-backend/tree/83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b).
Sources inspected include ProductsController/Service, VariantsController/Service,
ProductAccessService, product-presenter, AuthGuard and Products/Auth documentation.
No changes were made to Backend or its open Conversations PR.

Existing Backend reads:

| Existing OWNER API | Proposed internal tool |
| --- | --- |
| `GET /businesses/:businessId/products` | `get_products` |
| `GET /businesses/:businessId/products/:productId` | `get_product_details` |
| `GET /businesses/:businessId/products/:productId/variants` | `get_product_variants` |
| `GET /businesses/:businessId/products/:productId/variants/:variantId` | `get_variant_details` |

These public routes require a valid user session and active OWNER membership.
Products/variants are scoped in the service layer by business and parent IDs.
The new internal controller should reuse those read services, not bypass their
tenant filters, borrow an OWNER JWT or loosen AuthGuard on the public routes.
References: [Products API](https://github.com/shrouqshaker/brandora-backend/blob/83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b/docs/products-api.md),
[AuthGuard](https://github.com/shrouqshaker/brandora-backend/blob/83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b/src/auth/auth.guard.ts),
[presenter](https://github.com/shrouqshaker/brandora-backend/blob/83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b/src/products/product-presenter.ts).

The AI audit found:

* `POST /v1/ai/respond` uses the legacy Orchestrator with a caller-supplied catalog,
  legacy history and order behavior. It does not invoke Backend product tools.
* BackendClient already implements six strict read operations, per-call context
  headers, safe errors, no redirects/proxies and full response envelopes.
* BackendDataAccess already validates typed evidence and tenant/parent identity.
* RetrievalCoordinator bounds pages/calls/records/time and refreshes detail/variant
  evidence. Planner/Guard enforce active records, options and verified prices.
* ConversationInterpreter/NaturalResponder already provide Groq and rules fallback.
* The development adapter is loopback-only OWNER access, unsuitable as a service
  integration. It is **not used** by the new route.
* Missing pieces were an authenticated stateless HTTP boundary, verified inbound
  scope, Products-only capability restriction and deployment configuration checks.

## Architecture and responsibilities

```text
Backend authenticates/authorizes the triggering request
  → issues short-lived signed Products context
  → HTTPS FastAPI + X-Internal-Token + X-AI-Context
  → verify service credential, signature, claims and request binding
  → existing interpreter (no prior conversation)
  → existing bounded retrieval + typed BackendDataAccess
  → BackendClient POST /internal/ai/data (four product tools only)
  → existing variant-aware planner → Groq composition / deterministic fallback
  → existing grounding/response validation → unchanged E0-3 success response
```

Backend owns service identity, business authorization, data, effective prices,
inventory, context issuance and revocation. Python verifies the received context,
executes only allowlisted reads and validates evidence. The model cannot select
business scope, destination URLs, credentials or arbitrary tools. Credentials and
context tokens never enter prompts. Product references, colors, sizes and quantity
are selectors, not authorization or a stock reservation.

Each HTTP request owns execution state and a fresh empty Selection. No session
registry, customer IDs, conversation IDs, history retrieval or local fake identity
is introduced. Implicit follow-ups without a named product can require
clarification. The new Products-only binding mode permits business/message scope
without fabricated conversation identifiers and rejects supplied/prepared history.
Legacy execution keeps its existing complete-scope requirement.

## Proposed Backend internal contract

Backend `main` does **not** implement this endpoint yet:

`POST /internal/ai/data`

```http
Authorization: Bearer <AI_TO_BACKEND_SERVICE_CREDENTIAL>
X-AI-Context: <ORIGINAL_BACKEND_ISSUED_CONTEXT_TOKEN>
Content-Type: application/json
```

```json
{"tool":"get_products","arguments":{"limit":20,"offset":0}}
```

Allowed arguments (no businessId accepted from models):

| Tool | Required | Optional/defaults |
| --- | --- | --- |
| `get_products` | none | `limit=20`, `offset=0` |
| `get_product_details` | `productId` | none |
| `get_product_variants` | `productId` | `limit=20`, `offset=0` |
| `get_variant_details` | `productId`, `variantId` | none |

IDs are canonical UUID strings without extra Python UUID-version restrictions.
`limit` is integer 1..100, offset 0..JavaScript MAX_SAFE_INTEGER; booleans/floats
are rejected. Python method parameters remain snake_case; wire arguments are
camelCase. The Backend must independently validate the tool, arguments and scope.

Successful lists return:

```json
{
  "tool":"get_products",
  "data":{
    "pagination":{"limit":20,"offset":0,"totalCount":0,"hasMore":false,"nextOffset":null},
    "items":[]
  }
}
```

Details use direct data: `{tool:"get_product_details",data:<product>}` and
`{tool:"get_variant_details",data:<variant>}`. Do not introduce `data.product` or
`data.variant`. Return the existing presenter DTOs; lists include metadata and
embedded `variants`/`variantsPagination`, with further variants paginated through
the variants tool. The client/data layer retains the complete envelope.

Typed fields consumed:

* Product: id, businessId, name, description, basePrice, options, attributes,
  isActive, isSellable, variants and variantsPagination.
* Variant: id, businessId, catalogItemId, optionValues, unitPrice, effectivePrice,
  trackInventory, stockQuantity and isActive.
* Non-null money: fixed two-decimal strings, Decimal(12,2), at most ten integer
  digits. `effectivePrice` is authoritative; Python does not invent a base-price
  quote for an unresolved variant. Contradictory evidence is invalid.
* Tracked variant inventory requires integer quantity >=0; untracked requires
  null. Quantities are observations, not guaranteed availability. `isSellable`
  means active with an active priced variant, not stock/order eligibility.

Backend lists currently order by createdAt DESC/id DESC and use a repeatable-read
snapshot per operation. Multiple tool calls do not establish a common snapshot;
concurrent writes and bounded/incomplete catalogs retain safe caveats. Inactive
rows may be returned but are never treated as active sale evidence.

## Authentication and proposed signed-context profile

Two **different** random service credentials (minimum 32 printable ASCII
characters; no surrounding whitespace) are required:

* Backend → AI: `X-Internal-Token`, constant-time comparison with AI_SERVICE_TOKEN.
* AI → Backend: Bearer credential from BACKEND_SERVICE_TOKEN. Backend must validate
  its service purpose; a public OWNER session token is not a substitute.

The AI-side verifier implements this **proposed profile requiring Backend team
agreement**. It is not a description of already-existing context tokens:

* JWT signed RS256, `typ=JWT`. Optional bounded string `kid` is accepted, but
  verification always uses a locally configured static public key. No remote
  JWKS, token-controlled URLs, algorithm negotiation or unsigned decoding for
  authorization. Unsupported header fields/algorithms fail closed.
* Exact claims: `iss=brandora-backend`, `aud=brandora-ai-products`,
  `scope=products:read`, `businessId`, `messageId`, integer `iat`, integer `exp`.
  Optional integer `nbf`; all other claims are currently rejected.
* Require `iat <= now < exp`, lifetime <=300 seconds, zero clock leeway and a
  satisfied nbf when present. Clocks must be synchronized.
* Signed businessId/messageId must match the authenticated HTTP body. Only the
  verified business ID constructs ExpectedScope. Arbitrary UUIDs prove nothing.
* Backend alone holds a dedicated private signing key; AI receives its PUBLIC PEM
  verification key. Python has no context signing function or private key.
* Backend's internal endpoint must independently verify the same token, service
  identity and authorization, derive businessId from the token, and constrain
  every read by business/parent. Never merely accept a token forwarded by Python.

Verification uses the already-installed google-auth JWT/RSA implementation,
now declared explicitly in requirements with cryptography support. Verification
does not contact Google or require Google credentials. It is independent of Gemini.
Synthetic test RSA keys are generated in memory and never stored in Git.

This phase permits bounded replay of a valid read token; it has no write actions
or replay cache. Backend should enforce issuance policy, account permissions,
revocation as needed and per-service rate limits. Message binding is not a
cryptographic hash of customer text: the authenticated Backend caller remains
responsible for the message contents. Key rotation requires coordinated public-key
configuration; dynamic multi-key rotation/introspection is not implemented.
If Backend prefers another token profile, agree and test the verifier changes
before enabling staging. Do not pass opaque/OWNER tokens as if they were verified.

## FastAPI contract and compatibility

New, opt-in endpoint: **`POST /v2/ai/products/respond`**.
Versioning avoids replacing v1's catalog/history/order request semantics and
business rules. This is a Products endpoint, not activation of a general v2
conversation service. `PRODUCTS_INTEGRATION_ENABLED` defaults to disabled.

```http
X-Internal-Token: <BACKEND_TO_AI_SERVICE_CREDENTIAL>
X-AI-Context: <BACKEND_ISSUED_SIGNED_CONTEXT>
Content-Type: application/json
```

Body (example identifiers only):

```json
{
  "businessId":"00000001-0000-4000-8000-000000000001",
  "messageId":"00000009-0000-4000-8000-000000000001",
  "message":"black tshirt size L price"
}
```

Message is trimmed, nonblank and at most 2000 characters. Extra request fields
are rejected: do not supply catalog, history, credentials or arbitrary tools.
Success retains the **existing** E0-3 schema without adding fields:

```json
{"intent":"INQUIRY","reply":"A verified answer based on Backend products","requiresReview":false,"orderCandidate":null}
```

The reply above describes the shape, not a fabricated live answer. Purchase
enquiries may return PURCHASE_INTENT but never CONFIRMED_ORDER/orderCandidate.
Errors and safeguards:

| Condition | Behavior |
| --- | --- |
| Integration disabled | Route absent (404) |
| Unsafe/missing integration configuration | Application factory fails before serving |
| Missing/invalid service token or signed context | 401; no model/tool request |
| Valid signed context mismatches request IDs | 403; no model/tool request |
| Backend 401/403 or cross-tenant evidence | 403; no product answer |
| Invalid body | Existing sanitized 400 validation envelope |
| Non-HTTPS staging/production ingress | 400 |
| Backend 404/5xx/timeout/malformed evidence | Safe E0-3 clarification/unavailable response; no invented facts |
| Unexpected integration execution error | Sanitized 503; no provider traceback logged |

Groq uses the existing configured model list/budgets and ProviderChain. This
Products boundary uses Groq → deterministic Python, without adding providers or
changing the working standalone Groq/OpenRouter/Gemini configuration. Missing Groq
or invalid responses safely retain Python fallback. No startup Products/model call
is made. Legacy v1 provider/probe behavior is unchanged; use rules for legacy
AI_PROVIDER when operating the separate Groq Products endpoint.

## Environment variable names

Configure through private deployment settings; no real values belong in Git:

| Name | Purpose |
| --- | --- |
| APP_ENV | Explicit local/staging/production environment; local is for offline compatibility only |
| PRODUCTS_INTEGRATION_ENABLED | Explicit opt-in after Backend readiness |
| AI_SERVICE_TOKEN | Backend → AI credential |
| BACKEND_BASE_URL | Fixed Backend HTTP(S) origin, no path/userinfo/query/fragment |
| BACKEND_SERVICE_TOKEN | Different AI → Backend credential |
| BACKEND_CONTEXT_PUBLIC_KEY | RS256 public PEM; literal escaped newlines supported |
| BACKEND_TIMEOUT_SECONDS | Positive finite per-call timeout |
| GROQ_API_KEY | Existing optional provider credential |
| GROQ_MODELS | Existing Groq model selection, unchanged |
| CHAT_PROVIDER_TIMEOUT_SECONDS / CHAT_TOTAL_TIMEOUT_SECONDS / CHAT_CIRCUIT_SECONDS | Existing bounded provider settings |
| AI_PROVIDER | Existing legacy route selection; rules avoids legacy Gemini requirements |
| ENABLE_DEV_ENDPOINTS | Must remain disabled outside local development |

Staging/production refuses missing/weak service auth or enabled dev endpoints.
The product route always requires credentials and context verification, including
local tests. Outbound nonlocal HTTP origins are rejected; staging/production
requires HTTPS even for loopback. Redirects/proxy inheritance are disabled.
Configure the ingress/TLS proxy and Uvicorn's trusted proxy handling so ASGI sees
the authenticated HTTPS scheme; do not trust arbitrary forwarded headers.
APP_ENV must be explicitly correct in deployments; the application cannot detect
that an operator mislabeled a deployment as local. Health/readiness information
is not a substitute for authenticated staging acceptance.

## Implemented versus Backend work remaining

Implemented on AI side: signed request binding, constant-time service auth,
production configuration checks, fixed HTTPS Backend origin, four-tool allowlist,
typed bounded retrieval, variant-aware evidence/stock caveats, Groq/rules fallback,
unchanged E0-3 success responses and offline HTTP tests.

Backend team must:

1. Implement `/internal/ai/data` with dedicated service authentication, isolated
   from public OWNER JWT access. Provision/rotate the AI→Backend credential.
2. Agree to the proposed RS256 profile (or coordinate tested changes); provision
   a dedicated private signing key and distribute only its public verification
   key to AI. Issue short-lived authorized business/message contexts.
3. Verify service and context independently on every tool call; reject expired,
   wrong-audience, insufficient-scope and cross-business/parent requests.
4. Map exactly the four allowlisted reads to existing Product/Variant services;
   preserve DTOs, effectivePrice, pagination and variant inventory invariants.
5. Provision the separate Backend→AI credential, call the documented Products
   route over HTTPS and retain the original context in the outgoing header.
6. Provide controlled staging data, HTTPS connectivity, monitoring, request/body
   size and rate limits, revocation/rotation operations and negative auth tests.

No Backend deployment, database changes, OWNER credentials or Conversations PR
are needed to run the AI offline suite. They cannot substitute for completing
the secure internal endpoint before a real integration test.

## Offline tests and results

```powershell
$env:AI_PROVIDER='rules'
$env:ENABLE_DEV_ENDPOINTS='false'
$env:PYTHON_DOTENV_DISABLED='1'
.\venv\Scripts\python.exe -m pytest tests/test_products_integration.py -q
.\venv\Scripts\python.exe -m pytest -q
```

Full result: **1,425 passed, 2 existing warnings** (Starlette/httpx deprecation,
Windows pytest cache permissions). The 45 new cases use httpx.MockTransport and
in-memory synthetic signing keys. They cover actual FastAPI request handling,
scope/signature/time/credential failures, 401/403/404/5xx, malformed JSON/evidence,
timeouts, product/variant pagination, active states, quantities/stock caveats,
Groq composition, tenant isolation under concurrent requests, no Orders and
legacy route/schema compatibility. Existing v1 and standalone suites pass.
Rules and fake conversation evaluations also pass all checks (17 turns each).
The final whitespace check still reports the existing trailing blank whitespace
in `.env.example`; its unrelated formatting and existing Groq values were preserved.

Files changed for this delivery: `app/products_api.py`, `main.py`, `app/config.py`,
`app/clients/backend_client.py`, `app/pipeline/standalone.py`,
`app/chat/application.py`, `requirements.txt`, `.env.example`,
`tests/test_products_integration.py`, and this document. Earlier uncommitted work
and real `.env` remain untouched. Synthetic transports are test injections, not
an automatic fallback to fictional catalog data in the production route.

## Safe real staging acceptance once Backend is ready

Do not run this against production or before the internal endpoint/profile is
implemented and reviewed. Configure the environment names above privately, use
dedicated staging-only credentials, HTTPS origins, the Backend public signing
key, disabled dev endpoints and the enabled Products flag. No OWNER JWT is used.

Start the existing FastAPI application in the reviewed staging environment.
Have the authenticated Backend issue a fresh <=5-minute context for an authorized
staging business/message pair and send the documented JSON to the Products URL.
For an operator HTTP check, prepopulate these PowerShell process variables
privately: `BRANDORA_STAGING_PRODUCTS_URL`, `BRANDORA_BACKEND_TO_AI_CREDENTIAL`,
`BRANDORA_STAGING_CONTEXT`, `BRANDORA_STAGING_BUSINESS_ID`,
`BRANDORA_STAGING_MESSAGE_ID`. Then:

```powershell
$headers = @{
  'X-Internal-Token' = $env:BRANDORA_BACKEND_TO_AI_CREDENTIAL
  'X-AI-Context' = $env:BRANDORA_STAGING_CONTEXT
}
$body = @{
  businessId = $env:BRANDORA_STAGING_BUSINESS_ID
  messageId = $env:BRANDORA_STAGING_MESSAGE_ID
  message = 'Ask for a known staging product and variant'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $env:BRANDORA_STAGING_PRODUCTS_URL `
  -Headers $headers -ContentType 'application/json' -Body $body
```

Use a concrete authorized staging product name instead of the descriptive sample
message. Keep tokens out of command arguments, shell transcripts and shared logs.
Confirm Backend audit records contain only four read tools, correct tenant/parent
filters, expected effective prices/stock qualifications and no order writes.
Repeat with invalid inbound auth, expired context, wrong business/message binding,
inactive variants and Backend unavailability. Check there is no verified product
answer after failed retrieval. These checks, not offline success, establish real
integration readiness. **No authenticated staging call has been performed yet.**
