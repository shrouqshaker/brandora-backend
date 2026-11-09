# Customers, Conversations and Messages

Persistent chat history for WhatsApp customers. Examples were captured from the
real application (commit `dbda218`) on a disposable local database; IDs and times
are illustrative. Android-facing details, UX cases and the Postman collection
are in the [Android handoff](android-conversations-handoff.md).

Every endpoint is scoped by `businessId` in the path and needs
`Authorization: Bearer <accessToken>` from an active OWNER of that business
(`@AuthScope('params')`). No or invalid token answers `401 UNAUTHORIZED`. A
business you do not own, or one that does not exist, answers `404 NOT_FOUND`
before any lookup. A customer or conversation id from another business answers
`404 CUSTOMER_NOT_FOUND` / `404 CONVERSATION_NOT_FOUND`: an id is never looked up
on its own.

Phone numbers are stored as digits only, in international format
(`201000000001`, the same shape as WhatsApp's `wa_id`). `+20 100 000 0001` and
`0020-100-000-0001` are accepted on input and normalized. Local formats without
a country code (`01000000001`) are rejected with `INVALID_PHONE_NUMBER`.

Lists answer `{ "pagination": { limit, offset, totalCount, hasMore, nextOffset }, "items": [] }`
with `limit` 1–100 (default 20) and `offset` >= 0. Times are ISO-8601 UTC.

## Customers

`GET /businesses/:businessId/customers?limit=&offset=` — newest first.

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 2,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "47ccc71a-031c-494b-a946-4c6babbbdf7e",
      "businessId": "e02e6074-2b47-4e11-87ae-96e4b0e02322",
      "phone": "201000000002",
      "name": null,
      "createdAt": "2026-11-08T15:42:45.616Z",
      "updatedAt": "2026-11-08T15:42:45.616Z"
    },
    {
      "id": "b3edad44-0698-4930-9d9c-75e7c7af50aa",
      "businessId": "e02e6074-2b47-4e11-87ae-96e4b0e02322",
      "phone": "201000000001",
      "name": "Mona",
      "createdAt": "2026-11-08T15:42:45.505Z",
      "updatedAt": "2026-11-08T15:42:45.505Z"
    }
  ]
}
```

`GET /businesses/:businessId/customers/:customerId` returns one item of the
same shape. `name` is `null` when WhatsApp did not send a profile name.

Errors: `400 VALIDATION_ERROR` (malformed UUID or pagination),
`404 NOT_FOUND` (business), `404 CUSTOMER_NOT_FOUND`.

## Conversations

`GET /businesses/:businessId/conversations?status=OPEN|CLOSED&limit=&offset=`
— sorted by **`lastMessageAt`, newest first** (conversations without any message
time last, then by `id`). `updatedAt` is not used for ordering, because it also
changes when the owner changes a setting. Each item carries its customer and
`lastMessage` (the newest message, or `null`). Example (items shortened to one):

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 2,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "8676fb44-ce46-4dc4-a6bc-553c5e9cd27f",
      "businessId": "e02e6074-2b47-4e11-87ae-96e4b0e02322",
      "customerId": "b3edad44-0698-4930-9d9c-75e7c7af50aa",
      "channel": "WHATSAPP",
      "status": "OPEN",
      "aiEnabled": true,
      "handoffReason": null,
      "lastMessageAt": "2026-11-08T15:42:45.602Z",
      "lastCustomerMessageAt": "2026-11-08T15:42:45.602Z",
      "createdAt": "2026-11-08T15:42:45.507Z",
      "updatedAt": "2026-11-08T15:42:45.603Z",
      "customer": {
        "id": "b3edad44-0698-4930-9d9c-75e7c7af50aa",
        "phone": "201000000001",
        "name": "Mona"
      },
      "lastMessage": {
        "id": "688e0262-0941-43ed-837e-fe17c69b9c87",
        "conversationId": "8676fb44-ce46-4dc4-a6bc-553c5e9cd27f",
        "senderType": "CUSTOMER",
        "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAxFQIAEhgh",
        "content": "تمام، احجزيه",
        "messageType": "TEXT",
        "status": "RECEIVED",
        "aiMeta": null,
        "createdAt": "2026-11-08T15:42:45.602Z"
      }
    }
  ]
}
```

`GET /businesses/:businessId/conversations/:conversationId` returns the same
item **without** `lastMessage`.

| Field                   | Meaning                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `status`                | `OPEN` or `CLOSED`; a new customer message reopens a closed conversation |
| `aiEnabled`             | `false` when the owner took over and the AI stays silent                 |
| `handoffReason`         | Why the AI handed over (set with the AI work), otherwise `null`          |
| `lastMessageAt`         | Time of the newest message (customer, AI or owner); only moves forward   |
| `lastCustomerMessageAt` | Time of the newest customer message (24-hour reply window)               |

Both times are `null` until the first message. Every message is written by
`MessagesService` in the same transaction that moves these times, so
`lastMessageAt` always equals `lastMessage.createdAt`, whoever sent it.

MVP rule: one rolling conversation per customer per channel.

Errors: `400 VALIDATION_ERROR` (malformed UUID, unknown `status`, pagination),
`404 NOT_FOUND` (business), `404 CONVERSATION_NOT_FOUND`.

## Messages

`GET /businesses/:businessId/conversations/:conversationId/messages?limit=&offset=`
— **newest first**, so `offset` paging returns the latest page first; the client
reverses the page for display.

```json
{
  "pagination": {
    "limit": 2,
    "offset": 0,
    "totalCount": 3,
    "hasMore": true,
    "nextOffset": 2
  },
  "items": [
    {
      "id": "688e0262-0941-43ed-837e-fe17c69b9c87",
      "conversationId": "8676fb44-ce46-4dc4-a6bc-553c5e9cd27f",
      "senderType": "CUSTOMER",
      "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAxFQIAEhgh",
      "content": "تمام، احجزيه",
      "messageType": "TEXT",
      "status": "RECEIVED",
      "aiMeta": null,
      "createdAt": "2026-11-08T15:42:45.602Z"
    },
    {
      "id": "d28607be-f59b-4bd7-bb62-7e7ca3dae4b7",
      "conversationId": "8676fb44-ce46-4dc4-a6bc-553c5e9cd27f",
      "senderType": "AI",
      "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAxFQIAERgS",
      "content": "وعليكم السلام! أيوه موجود، السعر 299 جنيه. تحبي أحجزهولك؟",
      "messageType": "TEXT",
      "status": "READ",
      "aiMeta": {
        "intent": "INQUIRY",
        "requiresReview": false
      },
      "createdAt": "2026-11-08T15:42:45.562Z"
    }
  ]
}
```

| Field               | Values                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `senderType`        | `CUSTOMER`, `AI`, `OWNER`                                                                     |
| `messageType`       | `TEXT`, `IMAGE`, `AUDIO`, `VIDEO`, `DOCUMENT`, `LOCATION`, `OTHER`                            |
| `status`            | `RECEIVED` (customer messages), `PENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED` (sent by us) |
| `externalMessageId` | WhatsApp `wamid...`; `null` until a message we send is accepted by WhatsApp                   |
| `aiMeta`            | JSON returned by the AI for `AI` messages, otherwise `null`                                   |

Delivery status only moves forward (`SENT` → `DELIVERED` → `READ`). `FAILED` is
only accepted before delivery, and a delivered/read receipt replaces `FAILED`.
Each update is one conditional query, so late or repeated WhatsApp events can
never move a message backwards. Customer messages stay `RECEIVED`.

Errors: same as Conversations.

## Dev inbound message (temporary, local only)

`POST /businesses/:businessId/dev/inbound-message` simulates a WhatsApp message
until the webhook exists. It answers `404 NOT_FOUND` unless
`ENABLE_DEV_ENDPOINTS=true` **and** `DATABASE_URL` points at localhost, so it
stays off on any server even if the flag is set by mistake. Owner token
required. Delete it with the webhook work.

| Body field          | Rules                                                          |
| ------------------- | -------------------------------------------------------------- |
| `phone`             | Required, international number (see above)                     |
| `name`              | Optional, max 200; blank is ignored; updates the stored name   |
| `externalMessageId` | Optional, max 255; a repeat of a stored id is not stored again |
| `content`           | Required, 1–4096 characters (code points) after trimming       |
| `messageType`       | Optional, default `TEXT`                                       |

Unknown fields (including `senderType`) are rejected with `400 VALIDATION_ERROR`.

```json
{
  "phone": "+20 100 000 0001",
  "name": "Mona",
  "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAxFQIAEhgg",
  "content": "السلام عليكم، عندكم تيشيرت أسود مقاس L؟"
}
```

Answers **201** with `{ "duplicate": false, "customer", "conversation", "message" }`
when the message was stored, and **200** with `"duplicate": true` (nothing
written, the stored records returned) when `externalMessageId` was already
stored. Both are success: the future webhook must treat both as "done".
Concurrent requests with the same id store exactly one message.

Errors: `400 INVALID_PHONE_NUMBER`, `400 VALIDATION_ERROR`,
`404 NOT_FOUND` (switch off, or not your business),
`409 EXTERNAL_MESSAGE_ID_CONFLICT` (the id is stored under another business),
`409 CONFLICT` (a concurrent change outlasted the retry; retry the request).

## Message length

`content` is counted in Unicode code points, the same count as Python's `len()`
in the AI service: an Arabic letter or `😀` is 1, `👍🏽` (emoji + skin tone) is 2
and `❤️` (heart + variation selector) is 2. The limits live in
`src/messages/message-limits.ts`:

- **4096:** Meta's limit for one text message sent through the Cloud API, so
  every reply we send must fit it. The dev endpoint uses the same limit and
  rejects longer `content` with `400 VALIDATION_ERROR`. Customer messages from
  the WhatsApp webhook (next phase) are stored whatever their length, because
  the customer's WhatsApp app allows longer texts.
- **2000 (AI):** the AI service answers customer text up to this length. Longer
  texts are still stored and shown, never cut, and are not sent to the AI
  (`fitsAiLimit()`); with the AI work they go to the owner instead.

Nothing is truncated silently.

## Database rollout and rollback

The migration `20261107094154_add_customers_conversations` only adds five enums,
three tables, their indexes and foreign keys. It does not change any existing
table or row. `npm run test:conversations:postgres` proves this on a disposable
local database that starts from the main schema with an owner, business,
category, product and variant, and compares every main table before and after.

Deploy: back up first, then `npx prisma migrate deploy` (Railway/Neon in a
window agreed with Shrouq; never from a laptop against Production).

Rollback, only if the feature has to be removed before any real customer
writes: redeploy the application without this feature, back up, then run
[`prisma/maintenance/rollback-customers-conversations.sql`](../prisma/maintenance/rollback-customers-conversations.sql)
(`npx prisma db execute --file prisma/maintenance/rollback-customers-conversations.sql`).
It drops the three tables and five enums and removes the migration's history
row, so a later `migrate deploy` applies it again. It refuses to run while any
`Customer` row exists; with real chat history, restore the backup instead. It is
all-or-nothing and safe to run twice. The test above runs it, checks that the
database matches main again with the old rows untouched, and deploys again.

## Trying it locally

```bash
npx prisma migrate dev          # applies 20261107094154_add_customers_conversations
npx prisma db seed              # 2 businesses, 5 customers, 12 messages (localhost only, safe to repeat)
ENABLE_DEV_ENDPOINTS=true npm run start:dev
```

Seed business A is `a0000000-0000-4000-8000-000000000001` (4 customers, Arabic
and English, one closed conversation, one customer without a name). Business B,
`b0000000-0000-4000-8000-000000000002`, has a customer with the same phone as
one in A, to show uniqueness is per business. The seed refuses to run unless
`DATABASE_URL` is localhost.

## Tests

`npm run test:conversations:postgres` runs
[`verification/conversations-postgres.cjs`](../verification/conversations-postgres.cjs)
on a new random database on a localhost PostgreSQL server and deletes it
afterwards. It upgrades from the main schema with Prisma, checks drift, tenant
keys, two-owner isolation over real JWT HTTP, idempotency and races, time
ordering, delivery status rules, validation and the seed guard.
