# WhatsApp (Meta Cloud API)

**State:** ready on a local backend with Meta's test number; not enabled on
Railway. `WHATSAPP_ENABLED="false"` by default, like `AI_INTEGRATION_ENABLED`.

| Part                                    | State      | Who                         |
| --------------------------------------- | ---------- | --------------------------- |
| Webhook: verify (GET) and events (POST) | Ready      | Yomna                       |
| Linking a business to its number        | Ready      | Yomna (API), Yasmin (UI)    |
| Storing messages and delivery reports   | Ready      | Yomna                       |
| Sending replies (dry run and real)      | Ready      | Yomna                       |
| Production Meta app, number and secrets | Pending    | Team decision before launch |
| Media download (images, voice)          | Not in MVP | Later                       |

## Owner endpoints (Android)

Owner token required (`@AuthScope('params')`); another owner's business is 404.

| Method | Path                                          | Body                               |
| ------ | --------------------------------------------- | ---------------------------------- |
| GET    | `/businesses/:businessId/whatsapp-connection` | –                                  |
| PUT    | `/businesses/:businessId/whatsapp-connection` | `{ "phoneNumberId", "isActive"? }` |

`phoneNumberId` is Meta's id for the number (WhatsApp > API Setup > Phone
number ID), 6-30 digits. One number belongs to one business.

```json
{
  "businessId": "4e49df9f-60ff-4d44-862c-d957ee5a65c8",
  "phoneNumberId": "106540352242922",
  "isActive": true,
  "createdAt": "2026-11-11T13:35:05.030Z",
  "updatedAt": "2026-11-11T13:35:05.030Z"
}
```

Errors: `400 VALIDATION_ERROR`, `404 WHATSAPP_CONNECTION_NOT_FOUND` (GET before
linking), `409 WHATSAPP_PHONE_NUMBER_IN_USE`.

## Webhook (Meta only, never Android)

`GET /webhooks/whatsapp` answers `hub.challenge` as plain text when
`hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN`, else `403
WHATSAPP_VERIFY_TOKEN_INVALID`.

`POST /webhooks/whatsapp` requires `X-Hub-Signature-256` = HMAC-SHA256 of the
raw body with `WHATSAPP_APP_SECRET` (`401 WHATSAPP_SIGNATURE_INVALID`). The
business comes only from the stored link `phone_number_id -> business`, never
from the body. Messages and reports are stored **before** the 200, so a 200
means "safe in the database"; a database error (or a storage race that asks for
a retry) answers 500 and Meta resends later, which is safe because a repeated
`wamid` is stored once. Only errors a retry cannot fix are logged and skipped:
an invalid customer number, or a `wamid` that belongs to another business.
Replies are sent after the 200. Both routes answer `503 WHATSAPP_UNAVAILABLE`
while switched off.

| Meta message type                  | Stored as                                         |
| ---------------------------------- | ------------------------------------------------- |
| `text`                             | `TEXT`, the text exactly as sent                  |
| `image`, `video`, `document`       | `IMAGE` / `VIDEO` / `DOCUMENT`, `[image] caption` |
| `audio`, `voice`                   | `AUDIO`, `[voice]`                                |
| `location`                         | `LOCATION`, `[location] place`                    |
| `sticker`, `contacts`, other types | `OTHER`, `[sticker]`                              |
| `reaction`, `system`               | Not stored (not written by the customer)          |

Delivery reports `sent`, `delivered`, `read`, `failed` update our messages by
`wamid`, only forward (a late `delivered` never replaces `read`).

## Configuration

| Variable                 | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `WHATSAPP_ENABLED`       | `"true"` switches both routes and sending on                |
| `WHATSAPP_VERIFY_TOKEN`  | A random word (16+), typed in Meta's webhook settings too   |
| `WHATSAPP_APP_SECRET`    | Meta App secret; checks every POST signature                |
| `WHATSAPP_ACCESS_TOKEN`  | Sends messages; only needed when dry run is `"false"`       |
| `WHATSAPP_GRAPH_VERSION` | Meta Graph API version, default `v26.0`                     |
| `WHATSAPP_DRY_RUN`       | Anything but `"false"` logs replies instead of sending them |

Secrets live only in `.env` / Railway variables, never in Git, docs or chats.
Logs never contain message text or full customer numbers (`********0001`).

## Meta setup (test number)

1. developers.facebook.com > My Apps > Create App (Business) > add WhatsApp.
2. WhatsApp > API Setup: copy the Phone number ID, generate a temporary access
   token, add your own phone to the "To" list, send the `hello_world` test.
3. App settings > Basic: show and copy the App secret.
4. Run the backend with an HTTPS tunnel, then WhatsApp > Configuration >
   Webhook: Callback URL `https://<tunnel>/webhooks/whatsapp`, Verify token =
   `WHATSAPP_VERIFY_TOKEN`, Verify and save, then Subscribe to `messages`.
5. If the Test button reaches the server but messages from a phone do not, the
   app is not subscribed to the WhatsApp Business Account yet:
   `POST https://graph.facebook.com/<version>/<WABA_ID>/subscribed_apps` with
   the access token must answer `{"success":true}` (WABA ID = "WhatsApp
   Business Account ID" / "Messaging account ID" in API Setup).

## Tests

- `npm test`: `whatsapp-webhook.spec.ts` (verify token, signature, switch),
  `whatsapp-payload.spec.ts` (Meta shapes, never throws) and
  `whatsapp-inbound.spec.ts` (which errors are skipped, which make Meta retry).
- `npm run test:whatsapp:postgres`: a new local database, signed webhooks over
  real HTTP: stored once, the right business, one reply in dry run, forward-only
  reports, unknown or paused numbers ignored.
- By hand: `node verification/tools/send-whatsapp-webhook.cjs "text" [wamid]`.
