import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AiConversationStore, AiMessage } from '../ai/ai-conversation.store';
import { AiResponse } from '../ai/ai-response';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { createPagination } from '../common/pagination/pagination';
import {
  AI_MAX_CUSTOMER_TEXT_CHARACTERS,
  characterCount,
  fitsAiLimit,
  MESSAGE_MAX_CHARACTERS,
} from '../messages/message-limits';
import { MessagesService } from '../messages/messages.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reads only from the database, so the AI
 * service can never choose which business, customer or message it sees.
 */
@Injectable()
export class ConversationsAiStore extends AiConversationStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
  ) {
    super();
  }

  /** The customer message to answer: CUSTOMER + TEXT + short enough, in this business. */
  async current(
    businessId: string,
    conversationId: string,
    messageId: string,
  ): Promise<AiMessage> {
    const m = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        businessId,
        conversationId,
        senderType: 'CUSTOMER',
        messageType: 'TEXT',
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        conversation: { select: { customerId: true } },
      },
    });
    if (!m || !m.content.trim() || !fitsAiLimit(m.content))
      throw new AppHttpException(
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'No customer text message to answer',
      );
    return {
      businessId,
      customerId: m.conversation.customerId,
      conversationId,
      messageId: m.id,
      message: m.content,
      createdAt: m.createdAt.toISOString(),
      senderType: 'CUSTOMER',
      messageType: 'TEXT',
    };
  }

  async historyBefore(message: AiMessage, limit: number, offset: number) {
    const where = {
      businessId: message.businessId,
      conversationId: message.conversationId,
      createdAt: { lt: new Date(message.createdAt) },
    };
    const totalCount = await this.prisma.message.count({ where });
    const rows =
      offset >= totalCount
        ? []
        : await this.prisma.message.findMany({
            where,
            select: {
              id: true,
              conversationId: true,
              senderType: true,
              content: true,
              messageType: true,
              createdAt: true,
              externalMessageId: true,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit,
            skip: offset,
          });
    return {
      businessId: message.businessId,
      customerId: message.customerId,
      conversationId: message.conversationId,
      beforeMessageId: message.messageId,
      beforeMessageCreatedAt: message.createdAt,
      snapshot: createHash('sha256')
        .update(
          `${message.conversationId}:${message.messageId}:${message.createdAt}`,
        )
        .digest('hex'),
      order: 'createdAt_desc_id_desc',
      complete: true,
      pagination: createPagination({ limit, offset }, totalCount),
      items: rows.map((row) => ({
        ...row,
        // src/ai accepts at most 2000 characters per row: a longer row is
        // sent without its text, and the AI simply cannot use that turn.
        content:
          characterCount(row.content) > AI_MAX_CUSTOMER_TEXT_CHARACTERS
            ? null
            : row.content,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Stores the AI's answer once (PENDING). Sending happens in src/ai-replies. */
  async saveReply(
    message: AiMessage,
    response: AiResponse,
  ): Promise<AiResponse> {
    const long = characterCount(response.reply) > MESSAGE_MAX_CHARACTERS;
    const saved = await this.messages.createAiReply({
      businessId: message.businessId,
      conversationId: message.conversationId,
      replyToMessageId: message.messageId,
      // One WhatsApp message holds 4096 characters at most.
      content: long
        ? Array.from(response.reply)
            .slice(0, MESSAGE_MAX_CHARACTERS - 1)
            .join('') + '…'
        : response.reply,
      aiMeta: {
        intent: response.intent,
        requiresReview: response.requiresReview,
        source: 'ai',
        ...(long ? { truncated: true } : {}),
      },
    });
    // Answer with what is really stored: a repeat returns the first reply.
    const meta = saved.aiMeta as { intent?: string; requiresReview?: boolean };
    return {
      intent: (meta?.intent ?? 'OTHER') as AiResponse['intent'],
      reply: saved.content,
      requiresReview: meta?.requiresReview === true,
      orderCandidate: null,
    };
  }
}
