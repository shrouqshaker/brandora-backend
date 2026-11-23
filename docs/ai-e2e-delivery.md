# AI end to end: delivery notes (23 Nov 2026)

What the "Backend AI Integration Requirements" (21 Nov 2026) asked to hand
over, in one place. Contract: [ai-contract.md](ai-contract.md). Behaviour:
[ai-replies.md](ai-replies.md), [orders-api.md](orders-api.md),
[conversations-api.md](conversations-api.md).

## 1. The path that now works

```text
WhatsApp customer message
 -> saved once (unique wamid), 200 to Meta
 -> AI called once (claimForAi), in the background
 -> the AI reads products and history from /internal/ai/data
 -> verified reply saved once (unique replyToMessageId)
 -> reply sent once (claimForSending; retried only when Meta surely did not get it)
 -> PURCHASE_INTENT: alert on the chat (purchaseMessageId), no order, no stock
 -> owner makes the order from that message, approves it
 -> products, today's prices and stock checked again, stock taken once
 -> customer receives the confirmation
```

A restart at any point is finished by `ReplyRecoveryService` without a second
AI reply and without sending anything twice.

## 2. Commits

Merged in this order, each PR on `main` with "Create a merge commit":

| Branch                     | Commits | What                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------ |
| `feature/ai-conversations` | 5       | `replyToMessageId`, `ConversationsAiStore`, `src/ai-replies`, docs |
| `feature/orders`           | 6       | Order tables, create / approve / reject, WhatsApp confirmation     |
| `feature/human-handoff`    | 4       | AI switch, owner reply, automatic handoff                          |
| `feature/ai-e2e`           | 9       | once-only AI and sending, recovery, contract, orders checks, tests |

The exact list: `git log --oneline --reverse c65e05a..main`.

## 3. Migrations (all add only; old code keeps working)

| Folder                               | Adds                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `20261116145915_add_ai_reply_link`   | `Message.replyToMessageId` + unique index                                                        |
| `20261117020637_add_orders`          | `Order`, `OrderItem`, `OrderStatus`, unique `sourceMessageId`                                    |
| `20261123121400_add_reply_attempts`  | `Message.aiClaimedAt`, `aiAttempts`, `sendClaimedAt`, `sendAttempts`, `nextSendAt`, index status |
| `20261123150000_add_purchase_intent` | `Conversation.purchaseMessageId`, `purchaseIntentAt`                                             |

Apply them on the server database **before** the code: `npx prisma migrate
deploy` (Railway does not run migrations by itself).

## 4. Tests and results

| Command                               | Expected               |
| ------------------------------------- | ---------------------- |
| `npm test`                            | 929 passed (35 suites) |
| `npm run test:whatsapp:postgres`      | 39/39                  |
| `npm run test:conversations:postgres` | 10/10                  |

Run them on a machine with local PostgreSQL and keep the output, with the
date, for the hand-over: `npm run test:whatsapp:postgres > whatsapp-tests.txt 2>&1`.

Which test proves each acceptance line (`whatsapp-postgres.cjs`):

| Acceptance                             | Tests                  |
| -------------------------------------- | ---------------------- |
| saved once                             | 4, 18, 19, 37          |
| AI called once                         | 8, 18, 19, 20, 22, 37  |
| verified reply saved once              | 7, 8, 18, 37           |
| reply sent once                        | 18, 19, 21, 23, 24, 37 |
| purchase intent shown to the owner     | 31, 37                 |
| owner approval creates one order       | 11, 36, 37             |
| stock decreases once                   | 12, 34, 35, 37         |
| customer receives the confirmation     | 12, 32, 37             |
| handoff path (complaint → owner reply) | 16, 17, 38             |

The three results the requirements ask for by name:

- **Duplicate webhook:** tests 4 (three deliveries, one answer), 18 (two at the
  same moment), 19 (again later), 20 (again while the AI is still answering).
- **Concurrent approval:** tests 12 and 34 (two approvals of one order: one
  200, one 409, one stock movement), 35 (two orders for the last unit: one
  wins, stock never below zero).
- **Business isolation:** tests 2, 5, 11, 26, 29 here, and test 4 of
  `conversations-postgres.cjs` (another owner, foreign ids, no token).

## 5. Run it locally

```bash
npm ci
npx prisma migrate dev          # applies the 4 migrations, no reset
npm test
npm run test:whatsapp:postgres
npm run test:conversations:postgres
```

By hand with the fake AI ([ai-replies.md](ai-replies.md#run-it-locally)), or
with Malak's service on port 8000 instead of the fake.

## 6. Staging (Railway + Neon + Meta test number)

1. Backup Neon, then `npx prisma migrate deploy` against it.
2. Deploy `main`.
3. Variables (names only; values are set in Railway, never in Git or chats):
   `WHATSAPP_ENABLED`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_ACCESS_TOKEN` (permanent System User token), `WHATSAPP_DRY_RUN`
   (`false`), `WHATSAPP_GRAPH_VERSION`, `REPLY_RECOVERY_SECONDS`,
   `AI_INTEGRATION_ENABLED`, `AI_BASE_URL` (`https://`), `AI_SERVICE_TOKEN`,
   `BACKEND_SERVICE_TOKEN`, `AI_CONTEXT_PRIVATE_KEY`. The AI service needs
   `BACKEND_BASE_URL`, `BACKEND_CONTEXT_PUBLIC_KEY`, the same two tokens and its
   model keys.
4. Meta > WhatsApp > Configuration: Callback URL
   `https://<railway-domain>/webhooks/whatsapp`, the verify token, subscribe
   `messages`. Link the Phone number ID to the store
   (`PUT /businesses/:id/whatsapp-connection`).
5. Run the two scenarios below from a real phone and record them.

## 7. The two scenarios to record (video or screenshots)

Purchase: ask a price → the AI answers with the real price → "عايز ..." →
the chat shows the purchase alert → the owner makes the order → approves →
the stock in the app goes down by the quantity, once → the phone receives
"تم تأكيد طلبك ✅".

Handoff: send a complaint → the AI answers without inventing anything →
the chat shows `AI_REVIEW_REQUIRED` → a second message gets no automatic
answer → the owner replies from the app → the phone receives it.

## 8. Known limits (accepted for the MVP)

- After a stop **during** the call to Meta the reply is never resent (Meta may
  have it): it becomes `FAILED` and the owner sees it.
- Customer messages older than 15 minutes are not answered automatically after
  a long stop; the owner sees them in the inbox.
- Notifications to the owner are log lines until `NotificationService` exists
  (`OwnerNotifier`, one `useExisting` line).
- No media download, no templates after the 24-hour window.
