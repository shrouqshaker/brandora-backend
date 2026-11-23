import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { safeError } from '../common/logging/safe-error';
import { ConversationsService } from '../conversations/conversations.service';
import { fitsAiLimit } from '../messages/message-limits';
import { MessagesService, MessageView } from '../messages/messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service';
import { OWNER_NOTIFIER, OwnerNotifier } from './owner-notifier';

/** Sent when the AI cannot answer right now. It promises nothing about products. */
export const AI_FALLBACK_REPLY =
  'معلش، عندنا مشكلة صغيرة دلوقتي. صاحب المحل هيشوف رسالتك ويرد عليك 🙏';
/** Sent for voice notes, images and other non-text messages (MVP: text only). */
export const NON_TEXT_REPLY =
  'حاليًا بنقدر نرد على الرسايل المكتوبة بس 🙏 ممكن تكتبلنا طلبك؟';

/** Why the AI stepped back in a conversation (Conversation.handoffReason). */
export type HandoffReason =
  | 'AI_REVIEW_REQUIRED' // the AI said the owner should look (complaint, shortage...)
  | 'AI_UNAVAILABLE' // the AI failed twice in a row
  | 'MESSAGE_TOO_LONG'; // longer than the AI accepts (2000 characters)

/** One customer message that was just stored. */
export interface CustomerTurn {
  businessId: string;
  conversationId: string;
  messageId: string;
}

/**
 * Decides whether and how to answer a customer message, then sends the answer.
 * AiService does the AI part (signing, calling the AI, checking its
 * answer, saving it through ConversationsAiStore). This service only decides
 * and sends, and it never throws: the webhook must not fail because of a reply.
 *
 * Safe to call many times for the same message (repeated webhooks, two
 * servers, the recovery pass): the AI is called by one run only, and a
 * message that already has a reply is finished, never answered again.
 */
@Injectable()
export class AiReplyService {
  private readonly logger = new Logger('AiReply');

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly sender: WhatsAppSenderService,
    @Inject(OWNER_NOTIFIER) private readonly notifier: OwnerNotifier,
  ) {}

  async answer(turn: CustomerTurn): Promise<void> {
    try {
      await this.answerOrThrow(turn);
    } catch (error: unknown) {
      // Ids and an error code only: never the customer's text or a secret.
      this.logger.error(
        `Could not answer message ${turn.messageId}: ${safeError(error)}`,
      );
    }
  }

  private async answerOrThrow(turn: CustomerTurn): Promise<void> {
    const { businessId, conversationId, messageId } = turn;
    // 1) AI switched off for the whole backend.
    if (this.config.get<string>('AI_INTEGRATION_ENABLED') !== 'true') return;
    const conversation = await this.conversations.getOne(
      businessId,
      conversationId,
    );

    // 2) Already answered (a repeated webhook, another server, a restart):
    //    finish that reply if it was not sent yet. Never make a second one.
    const stored = await this.messages.findReplyTo(businessId, messageId);
    if (stored) return this.finish(turn, stored);

    // 3) The owner took this chat, or the AI stepped back: stay silent.
    if (!conversation.aiEnabled) return;

    // 4) One run per customer message: only the run that claims it goes on.
    if (!(await this.messages.claimForAi(businessId, messageId))) return;

    const customer = await this.prisma.message.findFirstOrThrow({
      where: { id: messageId, businessId, conversationId },
      select: { messageType: true, content: true },
    });
    // 5) Not text: a fixed, polite answer without calling the AI.
    if (customer.messageType !== 'TEXT') {
      const reply = await this.messages.createAiReply({
        businessId,
        conversationId,
        replyToMessageId: messageId,
        content: NON_TEXT_REPLY,
        aiMeta: { intent: 'OTHER', requiresReview: false, source: 'backend' },
      });
      return this.finish(turn, reply);
    }
    // 6) Longer than the AI accepts (2000): stored and shown, the owner answers.
    if (!fitsAiLimit(customer.content)) {
      await this.handOff(businessId, conversationId, 'MESSAGE_TOO_LONG');
      return;
    }

    // 7) The AI. On success the reply is already saved (PENDING) by the store.
    try {
      await this.ai.respond(businessId, { conversationId, messageId });
    } catch (error: unknown) {
      this.logger.warn(`AI did not answer ${messageId}: ${safeError(error)}`);
    }
    // 8) The saved reply, or a safe fixed one. Unique per customer message,
    //    so even a second run can never store two answers.
    const reply =
      (await this.messages.findReplyTo(businessId, messageId)) ??
      (await this.messages.createAiReply({
        businessId,
        conversationId,
        replyToMessageId: messageId,
        content: AI_FALLBACK_REPLY,
        aiMeta: { intent: 'OTHER', requiresReview: false, source: 'fallback' },
      }));
    await this.finish(turn, reply);
  }

  /**
   * Everything after a reply is stored: tell the owner, hand off if needed,
   * then send. It runs again when a stored reply was never sent (a restart),
   * so each part happens once: startHandoff is true once, and deliver()
   * sends a message at most once.
   */
  private async finish(turn: CustomerTurn, reply: MessageView): Promise<void> {
    if (reply.status !== 'PENDING') return; // sent or failed before
    const { businessId, conversationId } = turn;
    const meta = reply.aiMeta as {
      intent?: string;
      requiresReview?: boolean;
      source?: string;
    } | null;

    // Tell the owner when the customer wants to buy: she makes the order.
    if (meta?.intent === 'PURCHASE_INTENT')
      await this.notifier
        .purchaseIntent(businessId, conversationId)
        .catch(() => undefined);

    // Human handoff: the AI goes quiet here; this last reply is still sent.
    if (meta?.requiresReview === true)
      await this.handOff(businessId, conversationId, 'AI_REVIEW_REQUIRED');
    else if (meta?.source === 'fallback') {
      const before = await this.messages.previousAiReply(
        businessId,
        conversationId,
        reply.id,
      );
      const was = (before?.aiMeta as { source?: string } | null)?.source;
      if (was === 'fallback')
        await this.handOff(businessId, conversationId, 'AI_UNAVAILABLE');
    }

    await this.sender.deliver(businessId, reply.id);
  }

  /** Switch the AI off here and tell the owner, once (startHandoff is true once). */
  private async handOff(
    businessId: string,
    conversationId: string,
    reason: HandoffReason,
  ): Promise<void> {
    const switched = await this.conversations.startHandoff(
      businessId,
      conversationId,
      reason,
    );
    if (!switched) return;
    this.logger.log(`Handoff ${reason} in conversation ${conversationId}`);
    await this.notifier
      .handoffRequested(businessId, conversationId, reason)
      .catch(() => undefined);
  }
}
