# AI replies on WhatsApp (conversations side)

`src/ai/` (Shrouq) signs the request, calls the AI service and checks its
answer. This document covers the conversations side: the real
`AiConversationStore` and the trigger that answers customers.

## Flow

```text
WhatsApp webhook stores the customer message (200 to Meta)
 -> AiReplyService.answer()           src/ai-replies, in the background
    - AI_INTEGRATION_ENABLED != "true" or conversation.aiEnabled = false: no reply
    - not TEXT: fixed reply (source "backend"), the AI is not called
    - longer than 2000 characters: no reply, the owner answers
    - AiService.respond(businessId, { conversationId, messageId })
        -> ConversationsAiStore.current / historyBefore / saveReply
    - AI failed: fixed safe reply (source "fallback")
 -> WhatsAppSenderService.deliver()   PENDING -> SENT / FAILED
```

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
when `aiEnabled=false`.
