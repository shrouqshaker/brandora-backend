# Backend ↔ AI local alignment

This is a local, opt-in integration, not a deployed service. The current standalone
local `brandora-ai` checkout was reviewed at
`malkzidan/brandora-ai@a65969f26799cb6ec1616b10c0d6ef240d55ef6c`. That checkout was
clean at the baseline review; the local runner, canonical response bounds and
availability-word regression changes are now uncommitted there. The standalone
checkout is the source of truth for AI handoff; keep the repositories independent.

`src/ai/` is the NestJS adapter owned by `shrouqshaker/brandora-backend` and belongs
in the Backend application release, together with its regression tests. The
FastAPI service is maintained and deployed separately in `malkzidan/brandora-ai`.
Backend packaging does not publish or deploy that service.

For independent synthetic messages without persistence, use the separate
[local-only runner and Postman guide](ai-local-testing.md). It reuses domain
services against an isolated database and never changes the production provider.

## Implemented boundaries

- `POST /businesses/:businessId/ai/respond`: existing owner JWT/session and active
  OWNER membership are required. Body: `{conversationId, messageId}` only.
- `AiConversationStore.current` loads the existing CUSTOMER/TEXT message and
  attests business/customer/conversation/message ownership. Android cannot supply
  message text, history, customer identity, a context token or service credentials.
- NestJS sends exact UTF-8 JSON bytes to `POST /v2/ai/respond`:

```json
{
  "businessId": "<stored-business-uuid>",
  "customerId": "<stored-customer-uuid>",
  "conversationId": "<stored-conversation-uuid>",
  "messageId": "<stored-message-uuid>",
  "message": "<current-stored-message>"
}
```

- `X-Internal-Token` authenticates Backend → AI. `X-AI-Context` is an RS256 JWT,
  signed only by Backend. It binds those four identities, SHA-256 of the exact
  request body, issuer `brandora-backend`, audience `brandora-ai-tools-v1`,
  scope `products:read conversations:read`, `iat` and a 60-second `exp`.
- The current FastAPI canonical route uses Groq for structured interpretation
  and constrained response composition, with deterministic fallback. Python
  controls bounded read-only retrieval and requests history only when needed.
  It does not use the earlier proposed Gemini `ToolStep` loop. Business scope,
  credentials and URLs are supplied by trusted service code, not model output.
- The existing evidence planner and constrained natural-response generator stay
  responsible for facts, actual option combinations and safe read-only replies.
- NestJS validates the exact E0-3 fields, re-attests the source message, then
  invokes `saveReply`. There is no Order creation/update/cancellation.

## Internal tools

`POST /internal/ai/data` requires BOTH `Authorization: Bearer <BACKEND_SERVICE_TOKEN>`
and `X-AI-Context`. Its exemption from owner JWT is protected by `AiInternalGuard`;
it is not an anonymous shortcut. No service token is returned to Android.

```json
{
  "tool": "get_variant_details",
  "arguments": { "productId": "<uuid>", "variantId": "<uuid>" }
}
```

Returns `{tool, data}`; detail data is a direct object, collections use
`{items, pagination}`. All business scope comes from the signed context.

| Tool                     | Arguments                             | Existing source                                    |
| ------------------------ | ------------------------------------- | -------------------------------------------------- |
| get_products             | optional limit/offset                 | ProductsService.list                               |
| get_product_details      | productId                             | ProductsService.get                                |
| get_product_variants     | productId; optional limit/offset      | VariantsService.list                               |
| get_variant_details      | productId/variantId                   | VariantsService.get                                |
| get_business_info        | none                                  | BusinessesService profile/settings/hours aggregate |
| get_conversation_history | conversationId; optional limit/offset | AiConversationStore.historyBefore                  |

Unknown arguments, businessId arguments, invalid IDs, write tools and arbitrary
URLs are rejected. Pagination is 1..100, default 20/0. Internal responses are
limited to 128 KiB. The AI's current typed business mapper consumes the verified
business identity; additional settings/hours presentation is not claimed.
Products/variants reuse current presenters: prices are strings/null, zero stays
zero, effectivePrice is unitPrice ?? basePrice, stock is variant-level. Inactive
records remain explicit evidence so AI can decline them. No Catalog HTTP route
or owner login credential is used.

Backend supports all six tools, but the current canonical FastAPI allowlist
contains only the four Product/Variant tools plus conversation history.
`get_business_info` is therefore not an enabled canonical AI capability. Its
typed AI model also currently consumes only business identity, not settings or
working hours. Expanding that capability needs a separate agreed contract/test.

## Conversation dependency — fail closed

Current main has no Customer/Conversation/Message models. The cached branch
`origin/feature/customers-conversations@0e92d6b` contains their foundation, but
predates current auth/products and must not be enabled by copying old controllers.
No competing persistence, schema changes or migrations were introduced here.

The registered `UnavailableAiConversationStore` intentionally returns 503.
Thus the end-to-end customer path remains BLOCKED until the conversations team
provides and registers the real adapter. The synthetic request registry is used
only by the separate development runner and is never registered in AppModule.
The adapter must:

1. Attest all four identities and return only a persisted CUSTOMER/TEXT message.
2. Read history strictly before that source turn, with an immutable cutoff,
   stable snapshot/revision and deterministic createdAt DESC, id DESC ordering.
   Exclude current/future messages; retain CUSTOMER/AI/OWNER roles and timezone
   timestamps. Reject edits/deletions that invalidate the snapshot.
3. Return the `AuthorizedHistoryPage` shape already defined by AI: scope IDs,
   beforeMessageId/beforeMessageCreatedAt, snapshot, order, complete, pagination,
   items. Backend validates each page; AI validates consistent pages and bounds
   history to 3 pages/60 messages/12000 characters. Ambiguous timestamps or partial
   context produce clarification, never fabricated prior context.
4. Atomically persist at most one AI reply per sourceMessageId, reject stale or
   changed source turns and serialize conflicting conversation writes. Define
   idempotent replay/concurrency behavior before enabling the real adapter.

Context JWTs are intentionally reusable for multiple read tools for 60 seconds.
They do not authorize writes or claim durable anti-replay/exactly-once generation.
No refresh token or owner's access token is shared between services.

## Configuration and limits

Integration is disabled when the flag is unset; `.env.example` explicitly sets
`AI_INTEGRATION_ENABLED=false`. Keep it disabled while conversation persistence,
contract/security review and end-to-end verification remain incomplete. Setting
the flag alone cannot bypass the registered unavailable conversation store.

Future Backend opt-in: `AI_INTEGRATION_ENABLED=true`, `AI_BASE_URL`, `AI_SERVICE_TOKEN`,
`BACKEND_SERVICE_TOKEN`, `AI_CONTEXT_PRIVATE_KEY` (RSA >=2048 bits).
Unconfigured/disabled integration returns 503; existing authentication stays usable.
Service tokens must be distinct, printable non-whitespace ASCII, >=32 characters.
Only HTTPS origins or explicit HTTP loopback are accepted. Provider requests
reject redirects, abort after 30 seconds including body reads, cap body at 64 KiB
and do not retry. Provider, JSON, persistence and network errors are sanitized.
Store adapters must separately bound their database operations.

AI uses `BACKEND_CONTEXT_PUBLIC_KEY` (only the corresponding public key),
`AI_INTEGRATION_ENABLED`, `AI_SERVICE_TOKEN`, `BACKEND_SERVICE_TOKEN`,
`BACKEND_BASE_URL`, `APP_ENV`, `BACKEND_TIMEOUT_SECONDS`,
`INTEGRATION_TIMEOUT_SECONDS`, `TRUSTED_PROXY_CIDRS`, `GROQ_API_KEY`, `GROQ_MODELS`
and the `CHAT_*` provider budgets. Its release launcher forces the legacy provider
to rules mode and disables legacy routes; Gemini/OpenRouter configuration does
not activate those providers on the canonical route. Missing Groq credentials
permit deterministic fallback and are not proof of live model readiness.

Current AI defaults are 25 seconds for the canonical deadline and 5 seconds per
Backend call. Keep the complete AI deadline below Backend's 30-second outbound
timeout with room for transport; AI rejects total deadlines above 25
seconds, leaving five seconds below Backend's fixed 30-second HTTPS timeout. The issued
context expires after 60 seconds; retries must not extend its authorization.

Canonical request-local reads are capped at 12 calls, with caching. Each retrieval
has separate limits of 8 calls, 100 records and 5 seconds; history has separate
limits of 3 pages, 60 messages, 12000 characters and 5 seconds. These are nested
budgets, not the previously proposed Gemini tool-loop budgets.

Orders/candidates remain disabled in
this read-only profile: intent is INQUIRY/PURCHASE_INTENT/OTHER, reply is bounded,
requiresReview is boolean, orderCandidate is null. Original E0-3 schemas and
candidate identifiers are retained for future separately approved Orders work.

The AI integration does not modify Railway/Neon variables, deployment files,
import storage, user auth, refresh sessions or authentication email behavior. The separate
[Product schema rollout](product-domain-database-rollout.md) requires coordinated deployment.
No live model or deployed Backend test is implied by mocked test results.

## Remaining contract alignment before activation

Product reads now include `colorOptionName` / active image metadata; no image
write tool or image recognition is enabled. The FastAPI Product parser still
ignores these additional fields; the local compatibility fixes do not add image support. Its variant parser
still uses the retained JSON `catalogItemId` alias; internal Backend storage now
uses `productId`. Malak's future typed image contract and fallback requirements
are listed in [Product images](product-images.md#android-and-ai).

- Backend main has no conversation persistence adapter. Both request paths
  re-attest a stored source message, so the unavailable store blocks real use.
- Both validators exclude the entire current-message timestamp, independent of
  UUID order. Older rows sort by createdAt DESC/id DESC; CUSTOMER timestamp ties
  are ambiguous and rejected. The future store must attest ties across pages,
  immutable boundaries and stable snapshots; UUIDs do not establish causality.
- Both canonical history DTOs cap non-null content at 2000 Unicode code points,
  matching current messages. Oversized history is rejected without truncation;
  unavailable/partial history clarifies. Only nonblank CUSTOMER/TEXT content can
  reconstruct selectors; historical database storage is not rewritten.
- Product discovery is bounded pagination/local matching, not a Backend search
  endpoint or complete-catalog guarantee. Partial coverage must remain explicit.
- The AI release launcher requires verified proxy CIDRs for HTTPS attribution.
  No live ingress trust boundary or production settings were verified here.

Canonical output is already bounded to 20000 reply code points and 65536
serialized UTF-8 bytes. Local synthetic HTTP verification and its limits are
recorded in [local verification evidence](local-verification.md); production
conversation acceptance and live Groq remain unverified.
