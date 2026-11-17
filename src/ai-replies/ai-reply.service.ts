import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ConversationsService } from '../conversations/conversations.service';
import { fitsAiLimit } from '../messages/message-limits';
import { MessagesService } from '../messages/messages.service';
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
      this.logger.error(
        `Could not answer message ${turn.messageId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async answerOrThrow({
    businessId,
    conversationId,
    messageId,
  }: CustomerTurn): Promise<void> {
    // 1) AI switched off for the whole backend, or the owner took this chat.
    if (this.config.get<string>('AI_INTEGRATION_ENABLED') !== 'true') return;
    const conversation = await this.conversations.getOne(
      businessId,
      conversationId,
    );
    if (!conversation.aiEnabled) return;

    const customer = await this.prisma.message.findFirstOrThrow({
      where: { id: messageId, businessId, conversationId },
      select: { messageType: true, content: true },
    });
    // 2) Not text: a fixed, polite answer without calling the AI.
    if (customer.messageType !== 'TEXT') {
      const reply = await this.messages.createAiReply({
        businessId,
        conversationId,
        replyToMessageId: messageId,
        content: NON_TEXT_REPLY,
        aiMeta: { intent: 'OTHER', requiresReview: false, source: 'backend' },
      });
      await this.sender.deliver(businessId, reply.id);
      return;
    }
    // 3) Longer than the AI accepts (2000): stored and shown, the owner answers.
    if (!fitsAiLimit(customer.content)) {
      await this.handOff(businessId, conversationId, 'MESSAGE_TOO_LONG');
      return;
    }

    // 4) The AI. On success the reply is already saved (PENDING) by the store.
    try {
      await this.ai.respond(businessId, { conversationId, messageId });
    } catch (error: unknown) {
      const why =
        error instanceof AppHttpException
          ? `${error.getStatus()} ${error.code}`
          : 'unexpected error';
      this.logger.warn(`AI did not answer ${messageId}: ${why}`);
    }
    // 5) The saved reply, or a safe fixed one. Unique per customer message,
    //    so even a second run can never send two answers.
    const reply =
      (await this.messages.findReplyTo(businessId, messageId)) ??
      (await this.messages.createAiReply({
        businessId,
        conversationId,
        replyToMessageId: messageId,
        content: AI_FALLBACK_REPLY,
        aiMeta: { intent: 'OTHER', requiresReview: false, source: 'fallback' },
      }));
    await this.sender.deliver(businessId, reply.id);

    // 6) Tell the owner when the customer wants to buy: she makes the order.
    const meta = reply.aiMeta as {
      intent?: string;
      requiresReview?: boolean;
      source?: string;
    } | null;
    if (meta?.intent === 'PURCHASE_INTENT')
      await this.notifier
        .purchaseIntent(businessId, conversationId)
        .catch(() => undefined);

    // 7) Human handoff: the reply above is sent, then the AI goes quiet here.
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
