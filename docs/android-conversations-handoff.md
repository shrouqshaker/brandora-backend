# Conversations handoff for Yasmin — Android

**Contract reviewed against backend commit `dbda218` on branch
`feature/customers-conversations` (PR #1), 2026-11-08. Not merged or deployed yet.**
Every JSON body below was captured from the real application on a disposable
local database; IDs, tokens and times are illustrative. Until the PR is merged
and Railway is deployed, use a local test backend agreed with Yomna.

## 1. What is ready, test-only, or not built

| Area                                           | State         | Android uses it?  |
| ---------------------------------------------- | ------------- | ----------------- |
| Customers list and details                     | Ready         | Yes               |
| Conversations list (inbox) and details         | Ready         | Yes               |
| Messages of a conversation                     | Ready         | Yes               |
| `POST .../dev/inbound-message` (fake WhatsApp) | Test-only     | **No**            |
| WhatsApp webhook (real customer messages)      | Not built yet | No (server-side)  |
| Sending a reply from the app, AI on/off toggle | Not built yet | Later             |
| AI service integration (`/internal/ai/...`)    | Not built yet | **No** (internal) |

Android never needs Meta, WhatsApp or AI keys. Do not call internal or dev routes.

## 2. Connection and authentication

`baseUrl` per environment, no `/api` prefix, trailing slash in Retrofit. Local
emulator against a laptop backend: `http://10.0.2.2:3000/`. Production (after
deploy only): see [android-integration-guide.md](android-integration-guide.md).

```http
Authorization: Bearer <OWNER_ACCESS_TOKEN>
Accept: application/json
```

All routes are GET with no body. `businessId` is the owner's selected business
from the normal login/`/auth/me` flow.

| Answer                       | Meaning                                                       | Android action                                                              |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `401 UNAUTHORIZED`           | Missing, invalid or expired access token                      | Refresh once, then log in again                                             |
| `404 NOT_FOUND`              | Business is not yours or does not exist (hidden on purpose)   | Do **not** refresh; show "not available" and go back to the business picker |
| `404 CUSTOMER_NOT_FOUND`     | Customer id is not in this business                           | Remove it from the screen/cache                                             |
| `404 CONVERSATION_NOT_FOUND` | Conversation id is not in this business                       | Remove it from the screen/cache                                             |
| `400 VALIDATION_ERROR`       | Bad UUID, `limit`, `offset` or `status`: a bug in the request | Log it; do not retry                                                        |
| `500 INTERNAL_SERVER_ERROR`  | Unexpected server error                                       | Generic error with retry                                                    |

Read `code`, never `message` (English, for developers). Error body:

```json
{
  "statusCode": 404,
  "code": "CONVERSATION_NOT_FOUND",
  "message": "Conversation not found in this business",
  "error": "Not Found"
}
```

## 3. Endpoints

| Method | Path                                                              | Returns                       |
| ------ | ----------------------------------------------------------------- | ----------------------------- |
| GET    | `businesses/{businessId}/customers`                               | Page of customers             |
| GET    | `businesses/{businessId}/customers/{customerId}`                  | One customer                  |
| GET    | `businesses/{businessId}/conversations`                           | Page of conversations (inbox) |
| GET    | `businesses/{businessId}/conversations/{conversationId}`          | One conversation              |
| GET    | `businesses/{businessId}/conversations/{conversationId}/messages` | Page of messages              |

Path params are UUIDs (required). Query params:

| Param    | Type    | Default | Range              | Where                             |
| -------- | ------- | ------- | ------------------ | --------------------------------- |
| `limit`  | integer | 20      | 1–100              | All lists                         |
| `offset` | integer | 0       | ≥ 0                | All lists                         |
| `status` | enum    | (all)   | `OPEN` or `CLOSED` | Conversations list only, optional |

### 3.1 Customers list — newest first

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

`GET .../customers/{customerId}` returns one object of the same item shape:

```json
{
  "id": "b3edad44-0698-4930-9d9c-75e7c7af50aa",
  "businessId": "e02e6074-2b47-4e11-87ae-96e4b0e02322",
  "phone": "201000000001",
  "name": "Mona",
  "createdAt": "2026-11-08T15:42:45.505Z",
  "updatedAt": "2026-11-08T15:42:45.505Z"
}
```

### 3.2 Conversations list (inbox) — newest activity first

Sorted by `lastMessageAt` (newest first). `lastMessage` is the newest message in
the conversation, or `null`. Two items: a closed chat with a customer who has no
name, and an open chat.

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
      "id": "751c0d70-c066-4c84-8270-6af09c5355bb",
      "businessId": "e02e6074-2b47-4e11-87ae-96e4b0e02322",
      "customerId": "47ccc71a-031c-494b-a946-4c6babbbdf7e",
      "channel": "WHATSAPP",
      "status": "CLOSED",
      "aiEnabled": true,
      "handoffReason": null,
      "lastMessageAt": "2026-11-08T15:42:45.618Z",
      "lastCustomerMessageAt": "2026-11-08T15:42:45.618Z",
      "createdAt": "2026-11-08T15:42:45.617Z",
      "updatedAt": "2026-11-08T15:42:45.620Z",
      "customer": {
        "id": "47ccc71a-031c-494b-a946-4c6babbbdf7e",
        "phone": "201000000002",
        "name": null
      },
      "lastMessage": {
        "id": "c7022767-f85a-4d9c-a534-2c1f154d3317",
        "conversationId": "751c0d70-c066-4c84-8270-6af09c5355bb",
        "senderType": "CUSTOMER",
        "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAyFQIAEhgg",
        "content": "Hi, is delivery available today?",
        "messageType": "TEXT",
        "status": "RECEIVED",
        "aiMeta": null,
        "createdAt": "2026-11-08T15:42:45.618Z"
      }
    },
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

### 3.3 One conversation

Same fields as a list item, **without `lastMessage`**:

```json
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
  }
}
```

### 3.4 Messages — newest first

Page 1 (`limit=2&offset=0`):

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

Page 2 (`limit=2&offset=2`), the last page:

```json
{
  "pagination": {
    "limit": 2,
    "offset": 2,
    "totalCount": 3,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "125919e2-06e1-4441-b228-470cf4976998",
      "conversationId": "8676fb44-ce46-4dc4-a6bc-553c5e9cd27f",
      "senderType": "CUSTOMER",
      "externalMessageId": "wamid.HBgMMjAxMDAwMDAwMDAxFQIAEhgg",
      "content": "السلام عليكم، عندكم تيشيرت أسود مقاس L؟",
      "messageType": "TEXT",
      "status": "RECEIVED",
      "aiMeta": null,
      "createdAt": "2026-11-08T15:42:45.515Z"
    }
  ]
}
```

## 4. Fields, enums and nulls

| Field                                | Type / values                                                      | Can be null?                 |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------- |
| `customer.name`                      | string                                                             | Yes — show the phone instead |
| `customer.phone`                     | digits, international (`201000000001`); format it for display      | No                           |
| `conversation.channel`               | `WHATSAPP`                                                         | No                           |
| `conversation.status`                | `OPEN`, `CLOSED`                                                   | No                           |
| `conversation.aiEnabled`             | boolean                                                            | No                           |
| `conversation.handoffReason`         | string (for example `AI_REVIEW_REQUIRED`, later)                   | Yes                          |
| `conversation.lastMessageAt`         | ISO-8601 UTC; time of `lastMessage` (any sender)                   | Yes (no messages yet)        |
| `conversation.lastCustomerMessageAt` | ISO-8601 UTC                                                       | Yes                          |
| `lastMessage` (list only)            | message object                                                     | Yes                          |
| `message.senderType`                 | `CUSTOMER`, `AI`, `OWNER`                                          | No                           |
| `message.messageType`                | `TEXT`, `IMAGE`, `AUDIO`, `VIDEO`, `DOCUMENT`, `LOCATION`, `OTHER` | No                           |
| `message.status`                     | `RECEIVED`, `PENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED`       | No                           |
| `message.externalMessageId`          | WhatsApp id                                                        | Yes                          |
| `message.aiMeta`                     | JSON object (AI messages only)                                     | Yes                          |

- `handoffAt` exists in the database but is **not** returned yet.
- Times are UTC with milliseconds; convert to the device time zone for display.
- `content` is never truncated by the backend. Our replies are at most 4096
  characters; a customer message can be longer (WhatsApp allows it).
- Use `ignoreUnknownKeys = true`: new fields may be added (for example with the
  AI work), never removed or renamed without notice. Unknown enum values should
  fall back to a safe default (`coerceInputValues`) instead of crashing.
- `status` on customer messages is always `RECEIVED`; delivery ticks apply only
  to `AI`/`OWNER` messages and only move forward (`SENT` → `DELIVERED` → `READ`).

## 5. Paging the chat screen

1. Open a chat: `messages?limit=20&offset=0` → newest 20. **Reverse** them so the
   oldest is on top and the newest at the bottom.
2. User scrolls up: if `pagination.hasMore`, load `offset = pagination.nextOffset`
   and put the reversed page **above** the current list.
3. Stop when `hasMore` is `false` (`nextOffset` is `null`). An offset past the end
   returns `items: []`.
4. Pull-to-refresh / new message: reload `offset=0` and merge by `id` (an `id`
   never changes and is never shown twice).

The inbox uses the same `limit`/`offset` with the list already in display order.

## 6. UX cases

| Case                        | What the API does                                                         | Suggested UI                                   |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Empty inbox                 | `items: []`, `totalCount: 0` (example below)                              | Empty state: "No conversations yet"            |
| Customer without a name     | `customer.name` is `null`                                                 | Show the formatted phone                       |
| Non-text message            | `messageType` is not `TEXT` (media is not stored yet)                     | Show a label such as "Photo" / "Voice message" |
| Closed, then reopened       | `status=CLOSED`; a new customer message makes it `OPEN` again (same `id`) | Badge; refresh the inbox                       |
| AI handed over to the owner | `aiEnabled=false`, `handoffReason` set (with the AI work)                 | "Needs your reply" badge                       |
| Very long message           | Stored and returned unchanged, whatever its length                        | Show the full text; expand/collapse if needed  |
| Same WhatsApp message twice | Stored once; the second delivery creates nothing                          | Nothing to do: no duplicates appear            |
| Session expired             | `401 UNAUTHORIZED`                                                        | Refresh, then retry once                       |
| Business not available      | `404 NOT_FOUND`                                                           | Do not refresh; back to business picker        |
| No network / timeout        | No HTTP response                                                          | Offline message with retry                     |

Empty inbox:

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 0,
    "hasMore": false,
    "nextOffset": null
  },
  "items": []
}
```

## 7. Postman

Collection: [`docs/postman/brandora-conversations.postman_collection.json`](postman/brandora-conversations.postman_collection.json).
Import it, set `baseUrl`, `email`, `password`, then run **Auth → Login** (it
saves `token`) and **Business → Pick first business** (it saves `businessId`).
The folder **Android endpoints** holds the five GET routes with saved success
and error examples. The folder **Dev only (local test data)** creates fake
customer messages on a local backend; it is not an Android API. No real tokens
or secrets are stored in the collection.

Backend errors catalogue: [api-errors.md](api-errors.md).
