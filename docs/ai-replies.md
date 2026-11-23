# AI replies on WhatsApp (conversations side)

`src/ai/` (Shrouq) signs the request, calls the AI service and checks its
answer. This document covers the conversations side: the real
`AiConversationStore` and the trigger that answers customers.

## Flow

```text
WhatsApp webhook stores the customer message (200 to Meta), new or a repeat
 -> AiReplyService.answer()           src/ai-replies, in the background
    - AI_INTEGRATION_ENABLED != "true": nothing
    - the message already has a reply: finish it (send it if still PENDING)
    - conversation.aiEnabled = false: no reply
    - claimForAi(): only one run per customer message goes on
    - not TEXT: fixed reply (source "backend"), the AI is not called
    - longer than 2000 characters: no reply, the owner answers
    - AiService.respond(businessId, { conversationId, messageId })
        -> ConversationsAiStore.current / historyBefore / saveReply
    - AI failed: fixed safe reply (source "fallback")
    - finish(): owner alert, handoff, then send
 -> WhatsAppSenderService.deliver()   claimForSending(), PENDING -> SENT / FAILED
ReplyRecoveryService.sweep()          at start-up and every 30 s: what a stop interrupted
```

## Once only

| What happens                                         | Result                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Meta sends the same webhook twice, even at once      | One customer message (unique `wamid`), one AI call (`claimForAi`), one reply, one send       |
| Meta retries while the AI is still answering         | The retry finds the claim and stops; the first run answers                                   |
| `answer()` runs twice for one message                | The second finds the stored reply (unique `replyToMessageId`) and never calls the AI         |
| `deliver()` runs twice for one message               | Only the caller that sets `sendClaimedAt` calls Meta                                         |
| The server stops after storing, before the AI        | The recovery pass answers it (last 15 minutes, newest message of its chat only)              |
| The server stops while the AI is answering           | The claim (`aiClaimedAt`) expires after 2 minutes; the AI is asked again, twice in total max |
| The server stops after saving the reply, before Meta | The recovery pass sends it once                                                              |
| The server stops during the call to Meta             | Never sent again (Meta may have it): `FAILED` after 2 minutes, the owner sees it             |

## Send retry policy

Another try only when Meta surely did not take the message: HTTP 429, 5xx, or
no connection at all (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`). Three tries at
most: at once, after 30 seconds, after 2 more minutes (the recovery pass runs
the later ones; the message stays `PENDING` meanwhile). Everything else is
`FAILED` at once: a refusal (4xx, for example the 24-hour window), and a
timeout, because Meta may have sent it already. A customer can miss a reply,
but never gets the same reply twice. `REPLY_RECOVERY_SECONDS` (default 30,
`0` = off) sets how often the recovery pass runs.

Logs carry ids and error codes only (`safeError()`): never customer text,
never secrets.

## ConversationsAiStore (src/conversations/conversations-ai.store.ts)

| Requirement (docs/ai-integration.md)           | How                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Attest the four identities, CUSTOMER/TEXT only | `current()` reads by `id + businessId + conversationId`, `senderType CUSTOMER`, `messageType TEXT` |
| History strictly before the current message    | `createdAt < current.createdAt`, `createdAt DESC, id DESC`, 7 fields per row                       |
| Stable snapshot across pages                   | Messages never change and new ones are always later; `snapshot` = SHA-256 of the boundary          |
| At most one AI reply per source message        | `Message.replyToMessageId` is unique; a repeat returns the first reply                             |

Rows longer than 2000 code points are sent with `content: null` (the AI cannot
use that turn), because `src/ai` accepts at most 2000 per history row. Replies
longer than 4096 (one WhatsApp message) are cut to 4096 with `…` and marked
`aiMeta.truncated`. `aiMeta` = `{ intent, requiresReview, source }`.

## Run it locally

```bash
node verification/tools/make-ai-dev-secrets.cjs   # writes AI_* into .env and .tmp/ai-dev/ai.env
npm run start:dev                                  # terminal 1
node verification/tools/fake-ai-service.cjs        # terminal 2: fake AI on 127.0.0.1:8000
node verification/tools/send-whatsapp-webhook.cjs "التيشيرت بكام؟"
```

With Malak's real service instead of the fake (from the `brandora-ai` folder,
Python virtual environment): load `.tmp/ai-dev/ai.env` and run
`python -m uvicorn main:app --host 127.0.0.1 --port 8000`.

## Tests

`npm run test:whatsapp:postgres` (tests 7-10): real `src/ai` with the fake AI:
prices from real products, history read back, one reply per message even when
processed twice, AI down -> one fallback, non-text and too-long rules, silent
when `aiEnabled=false`. Tests 18-25: the same webhook twice at once and again
later, a retry while the AI is slow, Meta busy / refusing / busy three times,
a restart before the AI, after saving the reply and in the middle of a send,
images, voice notes and documents. `npm test`: `whatsapp-send-policy.spec.ts`
(which answers from Meta lead to another try).
