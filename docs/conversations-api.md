# Customers, Conversations and Messages

Persistent chat history for WhatsApp customers. Every endpoint is scoped by
`businessId` in the path, and a resource id from another business answers 404
(an id is never looked up on its own). There is currently no authentication:
business scoping is a database filter, not an authorization check.

Phone numbers are stored as digits only, in international format
(`201000000001`, the same shape as WhatsApp's `wa_id`). `+20 100 000 0001` and
`0020-100-000-0001` are accepted on input and normalized. Local formats without
a country code (`01000000001`) are rejected with `INVALID_PHONE_NUMBER`.

Lists answer `{ "pagination": { limit, offset, totalCount, hasMore, nextOffset }, "items": [] }`
with `limit` 1–100 (default 20) and `offset` >= 0.

## Customers

`GET /businesses/:businessId/customers?limit=&offset=` — newest first.

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 1,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "494e70dc-89c8-4905-b0d4-dd99481c98b6",
      "businessId": "a0000000-0000-4000-8000-000000000001",
      "phone": "201000000005",
      "name": "Nour",
      "createdAt": "2026-10-16T01:18:21.272Z",
      "updatedAt": "2026-10-16T01:18:21.272Z"
    }
  ]
}
```

`GET /businesses/:businessId/customers/:customerId` returns one item of the
same shape. `name` is `null` when WhatsApp did not send a profile name.

Errors: `400 VALIDATION_ERROR` (malformed UUID or pagination),
`404 BUSINESS_NOT_FOUND`, `404 CUSTOMER_NOT_FOUND`.

## Conversations

`GET /businesses/:businessId/conversations?status=OPEN|CLOSED&limit=&offset=`
— most recently active first. Each item carries its customer and `lastMessage`
(`null` if the conversation has no messages).

```json
{
  "id": "0ae07443-9a87-421e-99bd-2366671335cf",
  "businessId": "a0000000-0000-4000-8000-000000000001",
  "customerId": "494e70dc-89c8-4905-b0d4-dd99481c98b6",
  "channel": "WHATSAPP",
  "status": "OPEN",
  "createdAt": "2026-10-16T01:18:21.277Z",
  "updatedAt": "2026-10-16T01:18:21.277Z",
  "customer": {
    "id": "494e70dc-89c8-4905-b0d4-dd99481c98b6",
    "phone": "201000000005",
    "name": "Nour"
  },
  "lastMessage": {
    "id": "126d337c-e7ab-453e-9a7e-c704a09e6326",
    "conversationId": "0ae07443-9a87-421e-99bd-2366671335cf",
    "senderType": "CUSTOMER",
    "externalMessageId": "wamid.DEMO_1",
    "content": "عايزة أطلب تيشيرت XL",
    "messageType": "TEXT",
    "createdAt": "2026-10-16T01:18:21.280Z"
  }
}
```

`GET /businesses/:businessId/conversations/:conversationId` returns the same
item without `lastMessage`.

MVP rule: one rolling conversation per customer per channel. A new customer
message reopens a `CLOSED` conversation.

Errors: `400 VALIDATION_ERROR` (malformed UUID, unknown `status`),
`404 BUSINESS_NOT_FOUND`, `404 CONVERSATION_NOT_FOUND`.

## Messages

`GET /businesses/:businessId/conversations/:conversationId/messages?limit=&offset=`
— **newest first**, so `offset` paging returns the latest page first; the client
reverses the page for display.

`senderType` is `CUSTOMER`, `AI` or `OWNER`. `messageType` is `TEXT`, `IMAGE`,
`AUDIO`, `VIDEO`, `DOCUMENT`, `LOCATION` or `OTHER`. `externalMessageId` is the
WhatsApp `wamid...` for customer messages and `null` for messages we send.

```json
{
  "pagination": {
    "limit": 2,
    "offset": 0,
    "totalCount": 4,
    "hasMore": true,
    "nextOffset": 2
  },
  "items": [
    {
      "id": "25fb6a49-52e6-4543-b4fd-0eb30d3adc34",
      "conversationId": "cd6a1eb5-53b5-42f5-89f2-cb58013e2c97",
      "senderType": "OWNER",
      "externalMessageId": null,
      "content": "السعر ٢٩٩ جنيه والتوصيل بكرة إن شاء الله.",
      "messageType": "TEXT",
      "createdAt": "2026-10-16T09:03:00.000Z"
    }
  ]
}
```

Errors: same as Conversations.

## Dev inbound message (temporary)

`POST /businesses/:businessId/dev/inbound-message` simulates a WhatsApp message
until the webhook exists. It answers `404 NOT_FOUND` unless
`ENABLE_DEV_ENDPOINTS=true`. Never enable it in production; delete it with the
webhook work.

| Body field          | Rules                                                          |
| ------------------- | -------------------------------------------------------------- |
| `phone`             | Required, international number (see above)                     |
| `name`              | Optional, max 200; blank is ignored; updates the stored name   |
| `externalMessageId` | Optional, max 255; a repeat of a stored id is not stored again |
| `content`           | Required, 1–4096 characters                                    |
| `messageType`       | Optional, default `TEXT`                                       |

Unknown fields (including `senderType`) are rejected.

```json
{
  "phone": "+20 100 000 0005",
  "name": "Nour",
  "externalMessageId": "wamid.DEMO_1",
  "content": "عايزة أطلب تيشيرت XL"
}
```

Answers **201** with `{ "duplicate": false, "customer", "conversation", "message" }`
when the message was stored, and **200** with `"duplicate": true` (nothing
written, the stored records returned) when `externalMessageId` was already
stored. Both are success: the future webhook must treat both as "done".

Errors: `400 INVALID_PHONE_NUMBER`, `400 VALIDATION_ERROR`,
`404 BUSINESS_NOT_FOUND`, `404 NOT_FOUND` (switch off),
`409 EXTERNAL_MESSAGE_ID_CONFLICT` (the id is stored under another business).

## Trying it locally

```bash
npx prisma migrate dev          # applies add_customer_conversation
npx prisma db seed              # 2 businesses, 5 customers, 12 messages (safe to repeat)
ENABLE_DEV_ENDPOINTS=true npm run start:dev
```

Seed business A is `a0000000-0000-4000-8000-000000000001` (4 customers, Arabic
and English, one closed conversation, one customer without a name). Business B,
`b0000000-0000-4000-8000-000000000002`, has a customer with the same phone as
one in A, to show uniqueness is per business.
