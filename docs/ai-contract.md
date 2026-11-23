# Backend ↔ AI contract (final, 22 Nov 2026)

One page for the agreed contract. Security details and limits are in
[ai-integration.md](ai-integration.md); what the backend does with each reply
is in [ai-replies.md](ai-replies.md). Android never calls the AI and never
sends history: the WhatsApp webhook triggers every AI call.

## 1. Backend → AI: `POST /v2/ai/respond`

Headers:

| Header             | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| `X-Internal-Token` | `AI_SERVICE_TOKEN` (Backend → AI credential)                  |
| `X-AI-Context`     | RS256 JWT signed by the Backend (`AI_CONTEXT_PRIVATE_KEY`)    |
| `Content-Type`     | `application/json`, exactly the bytes hashed in `requestHash` |

Body: these five fields and nothing else (the AI forbids extra keys).

```json
{
  "businessId": "<uuid>",
  "customerId": "<uuid>",
  "conversationId": "<uuid>",
  "messageId": "<uuid of the stored customer message>",
  "message": "<its stored text, 1-2000 characters>"
}
```

Every value comes from the database (`ConversationsAiStore.current`), never
from Android, the customer or the model. No history is sent: the AI asks for
it with `get_conversation_history`.

Context claims: `iss: brandora-backend`, `aud: brandora-ai-tools-v1`,
`scope: products:read conversations:read`, the four ids of the body,
`requestHash` = SHA-256 of the exact body, `iat`, `exp` (60 seconds). The AI
refuses any difference between the body ids and the claims.

Answer (exactly four keys; anything else is treated as an AI failure):

```json
{
  "intent": "INQUIRY",
  "reply": "...",
  "requiresReview": false,
  "orderCandidate": null
}
```

`intent` is `INQUIRY`, `PURCHASE_INTENT` or `OTHER`. `CONFIRMED_ORDER` and a
non-null `orderCandidate` are refused. `PURCHASE_INTENT` is never an order:
the owner sees it and makes the order herself
([orders-api.md](orders-api.md)). `requiresReview: true` hands the chat to the
owner after this reply (complaint, not understood, stock problem, anything
critical: the AI decides).

## 2. AI → Backend: `POST /internal/ai/data`

Headers: `Authorization: Bearer <BACKEND_SERVICE_TOKEN>` and the same
`X-AI-Context` it received. Body: `{ "tool": "...", "arguments": { ... } }`.
Answer: `{ "tool": "<same name>", "data": ... }`, at most 128 KiB.

| Tool                       | Arguments (required; optional)      | `data`                                 |
| -------------------------- | ----------------------------------- | -------------------------------------- |
| `get_products`             | –; `limit`, `offset`                | `{ items: Product[], pagination }`     |
| `get_product_details`      | `productId`                         | `Product`                              |
| `get_product_variants`     | `productId`; `limit`, `offset`      | `{ items: Variant[], pagination }`     |
| `get_variant_details`      | `productId`, `variantId`            | `Variant`                              |
| `get_conversation_history` | `conversationId`; `limit`, `offset` | the history page below                 |
| `get_business_info`        | –                                   | `{ business, settings, workingHours }` |

`get_business_info` stays for compatibility, scoped to the signed business like
the others. The AI does not call it today (its `/v2/ai/respond` client allows
only the five tools above, `CONVERSATION_TOOLS`), so the shape of its answer is
not part of this contract yet; using it needs an agreed version of this page.

Business scope comes only from the signed context. Refused:

| Request                                                       | Answer |
| ------------------------------------------------------------- | ------ |
| No `Authorization`, a wrong token, no or a bad `X-AI-Context` | `401`  |
| A context for another message, or a message changed since     | `401`  |
| `conversationId` of another chat                              | `401`  |
| An unknown tool or any write tool                             | `400`  |
| `businessId`, a URL or any unknown key in `arguments`         | `400`  |
| `limit` outside 1-100, `offset` < 0, numbers sent as strings  | `400`  |
| A `productId` / `variantId` of another business               | `404`  |
| History that cannot be ordered for sure (see below)           | `503`  |

## 3. Official field names (DTO)

`Variant` carries `productId` (the official name) **and** `catalogItemId`
(the same value, kept for readers written before the rename). Both stay; no
other field is renamed without a new version of this page. Prices are decimal
strings (`"250.00"`) or `null`; `effectivePrice = unitPrice ?? basePrice`;
stock is per variant (`trackInventory`, `stockQuantity`).

## 4. History page

`get_conversation_history` returns the turns strictly **before** the current
message of the signed context: never the current message, nothing at its exact
moment, nothing later, only this business, customer and chat. Newest first by
`createdAt`, then `id` (the id only breaks ties). Two customer messages at the
very same moment cannot be ordered, so the page is refused (`503`) instead of
guessed. Shape:

```json
{
  "businessId": "...",
  "customerId": "...",
  "conversationId": "...",
  "beforeMessageId": "...",
  "beforeMessageCreatedAt": "2026-11-22T10:00:00.000Z",
  "snapshot": "<sha-256>",
  "order": "createdAt_desc_id_desc",
  "complete": true,
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 3,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "...",
      "conversationId": "...",
      "senderType": "OWNER",
      "messageType": "TEXT",
      "content": "...",
      "createdAt": "...",
      "externalMessageId": null
    }
  ]
}
```

A row longer than 2000 characters has `content: null`.

## 5. Tests

`npm run test:whatsapp:postgres` tests 26-30 (real database, real HTTP):
isolation of business, customer and chat; the cutoff; stable pages while new
messages arrive; equal timestamps; every refusal above; both variant names.
`npm test`: `ai-integration.spec.ts` (signing, binding, limits).
