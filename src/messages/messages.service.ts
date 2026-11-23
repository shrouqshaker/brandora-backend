import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/database/is-unique-violation';
import { createPagination } from '../common/pagination/pagination';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import {
  MessageDeliveryStatus,
  MessageSenderType,
  MessageType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const messageSelect = {
  id: true,
  conversationId: true,
  senderType: true,
  externalMessageId: true,
  content: true,
  messageType: true,
  status: true,
  aiMeta: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

export type MessageView = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;

type DeliveryUpdate = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** How one send ended: Meta's id, FAILED for good, or RETRY later (only when Meta surely did not take it). */
export type SendResult = { externalMessageId: string } | 'FAILED' | 'RETRY';

const { PENDING, SENT, DELIVERED, FAILED } = MessageDeliveryStatus;

/** How long one AI run may hold a customer message (the AI call stops after 30 seconds). */
export const AI_LEASE_MS = 2 * 60 * 1000;
/** A customer message goes to the AI twice at most: again only if the first run crashed. */
export const AI_MAX_ATTEMPTS = 2;
/** A send that started and never ended (the server stopped mid-call) is given up after this. */
export const SEND_LEASE_MS = 2 * 60 * 1000;
/** Sends started for one message, at most: now, then after each delay below. */
export const SEND_MAX_ATTEMPTS = 3;
export const SEND_RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000];

/**
 * For each new status: the statuses a message is allowed to move from.
 * SENT -> DELIVERED -> READ only moves forward. FAILED only before delivery,
 * and a delivered or read receipt proves delivery, so it also replaces FAILED.
 * Customer messages (RECEIVED) are never in these lists, so they never change.
 */
const ALLOWED_FROM: Record<DeliveryUpdate, MessageDeliveryStatus[]> = {
  SENT: [PENDING],
  DELIVERED: [PENDING, SENT, FAILED],
  READ: [PENDING, SENT, DELIVERED, FAILED],
  FAILED: [PENDING, SENT],
};

/**
 * The only place that writes messages. Every new message also moves its
 * conversation's times forward in the same transaction, so the inbox order
 * (lastMessageAt) always matches lastMessage, whoever sent it.
 */
@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** A customer message. Runs inside the caller's transaction. */
  async createInbound(
    tx: Prisma.TransactionClient,
    data: {
      businessId: string;
      conversationId: string;
      externalMessageId: string | null;
      content: string;
      messageType: MessageType;
    },
  ) {
    const message = await tx.message.create({
      data: {
        ...data,
        senderType: MessageSenderType.CUSTOMER,
        status: MessageDeliveryStatus.RECEIVED,
      },
      select: messageSelect,
    });
    await this.moveTimesForward(
      tx,
      data.businessId,
      data.conversationId,
      message.createdAt,
      true,
    );
    return message;
  }

  /** An AI or owner message, stored as PENDING before it is sent. */
  createOutbound(data: {
    businessId: string;
    conversationId: string;
    senderType: 'AI' | 'OWNER';
    content: string;
    aiMeta?: Prisma.InputJsonValue;
    replyToMessageId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: { ...data, status: PENDING },
        select: messageSelect,
      });
      // Our reply is new activity, but not a customer message: the 24-hour
      // window (lastCustomerMessageAt) stays where it is.
      await this.moveTimesForward(
        tx,
        data.businessId,
        data.conversationId,
        message.createdAt,
        false,
      );
      return message;
    });
  }

  /**
   * Takes a PENDING message for one send. Returns the try number (1, 2, 3)
   * to exactly one caller, or null when someone is sending it now, it waits
   * for its next try (nextSendAt), or it is out of tries.
   */
  async claimForSending(
    businessId: string,
    id: string,
  ): Promise<number | null> {
    const now = new Date();
    const [claimed] = await this.prisma.message.updateManyAndReturn({
      where: {
        id,
        businessId,
        status: PENDING,
        sendClaimedAt: null,
        sendAttempts: { lt: SEND_MAX_ATTEMPTS },
        OR: [{ nextSendAt: null }, { nextSendAt: { lte: now } }],
      },
      data: { sendClaimedAt: now, sendAttempts: { increment: 1 } },
      select: { sendAttempts: true },
    });
    return claimed?.sendAttempts ?? null;
  }

  /**
   * After the send attempt: SENT with WhatsApp's id, FAILED, or still
   * PENDING with the time of the next try (RETRY; FAILED after the last try).
   * Only changes a PENDING message of this business, so a retry or a late
   * call can never overwrite a status that already moved on.
   */
  async markSendResult(
    businessId: string,
    id: string,
    result: SendResult,
    attempt = 1,
  ) {
    const failed =
      result === 'FAILED' ||
      (result === 'RETRY' && attempt >= SEND_MAX_ATTEMPTS);
    try {
      await this.prisma.message.updateMany({
        where: { id, businessId, status: PENDING },
        data: failed
          ? { status: FAILED, sendClaimedAt: null }
          : result === 'RETRY'
            ? {
                sendClaimedAt: null,
                nextSendAt: new Date(
                  Date.now() + SEND_RETRY_DELAYS_MS[attempt - 1],
                ),
              }
            : {
                status: SENT,
                externalMessageId: result.externalMessageId,
                sendClaimedAt: null,
              },
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      // WhatsApp ids are unique; one that is already stored means a replay
      // or a bug. Nothing was changed: the message is still PENDING.
      throw new AppHttpException(
        ErrorCode.EXTERNAL_MESSAGE_ID_CONFLICT,
        HttpStatus.CONFLICT,
        'externalMessageId already belongs to another message',
      );
    }
    return this.prisma.message.findFirstOrThrow({
      where: { id, businessId },
      select: messageSelect,
    });
  }

  /**
   * The AI's answer to one customer message, stored PENDING. At most one per
   * customer message (unique replyToMessageId): a second call gets the first.
   */
  async createAiReply(data: {
    businessId: string;
    conversationId: string;
    replyToMessageId: string;
    content: string;
    aiMeta: Prisma.InputJsonValue;
  }): Promise<MessageView> {
    try {
      return await this.createOutbound({ ...data, senderType: 'AI' });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const first = await this.findReplyTo(
        data.businessId,
        data.replyToMessageId,
      );
      if (!first) throw error;
      return first;
    }
  }

  /**
   * Takes a customer message for the AI. True for one caller only: a repeated
   * webhook, a second server or the recovery pass get false while the first
   * run holds it. A run that crashed lets go after AI_LEASE_MS.
   */
  async claimForAi(businessId: string, messageId: string): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.message.updateMany({
      where: {
        id: messageId,
        businessId,
        senderType: MessageSenderType.CUSTOMER,
        aiAttempts: { lt: AI_MAX_ATTEMPTS },
        OR: [
          { aiClaimedAt: null },
          { aiClaimedAt: { lt: new Date(now.getTime() - AI_LEASE_MS) } },
        ],
      },
      data: { aiClaimedAt: now, aiAttempts: { increment: 1 } },
    });
    return count === 1;
  }

  /** The AI reply already stored for this customer message, or null. */
  findReplyTo(businessId: string, replyToMessageId: string) {
    return this.prisma.message.findFirst({
      where: { businessId, replyToMessageId },
      select: messageSelect,
    });
  }

  /** The AI message sent just before `exceptId` in this conversation, if any. */
  previousAiReply(
    businessId: string,
    conversationId: string,
    exceptId: string,
  ) {
    return this.prisma.message.findFirst({
      where: {
        businessId,
        conversationId,
        senderType: MessageSenderType.AI,
        id: { not: exceptId },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: messageSelect,
    });
  }

  /** Newest first, so offset paging returns the latest page first; clients reverse for display. */
  async listForConversation(
    businessId: string,
    conversationId: string,
    page: PaginationQueryDto,
  ) {
    const where = { businessId, conversationId };
    const totalCount = await this.prisma.message.count({ where });
    const items =
      page.offset >= totalCount
        ? []
        : await this.prisma.message.findMany({
            where,
            select: messageSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: page.limit,
            skip: page.offset,
          });
    return { pagination: createPagination(page, totalCount), items };
  }

  async updateDeliveryStatus(
    businessId: string,
    externalMessageId: string,
    status: DeliveryUpdate,
  ): Promise<boolean> {
    const { count } = await this.prisma.message.updateMany({
      where: {
        businessId,
        externalMessageId,
        status: { in: ALLOWED_FROM[status] },
      },
      data: { status },
    });
    return count > 0;
  }

  /**
   * Sets the conversation's times to `at` only where `at` is newer (or the
   * time is still empty), so a late or concurrent write never pulls them back.
   */
  private async moveTimesForward(
    tx: Prisma.TransactionClient,
    businessId: string,
    conversationId: string,
    at: Date,
    fromCustomer: boolean,
  ): Promise<void> {
    const conversation = { id: conversationId, businessId };
    await tx.conversation.updateMany({
      where: {
        ...conversation,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }],
      },
      data: { lastMessageAt: at },
    });
    if (!fromCustomer) return;
    await tx.conversation.updateMany({
      where: {
        ...conversation,
        OR: [
          { lastCustomerMessageAt: null },
          { lastCustomerMessageAt: { lt: at } },
        ],
      },
      data: { lastCustomerMessageAt: at },
    });
  }
}
