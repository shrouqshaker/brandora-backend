import { Injectable } from '@nestjs/common';
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

const { PENDING, SENT, DELIVERED, FAILED } = MessageDeliveryStatus;

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
   * After the send attempt: SENT with WhatsApp's id, or FAILED.
   * Only changes a PENDING message of this business, so a retry or a late
   * call can never overwrite a status that already moved on.
   */
  async markSendResult(
    businessId: string,
    id: string,
    result: { externalMessageId: string } | 'FAILED',
  ) {
    await this.prisma.message.updateMany({
      where: { id, businessId, status: PENDING },
      data:
        result === 'FAILED'
          ? { status: FAILED }
          : { status: SENT, externalMessageId: result.externalMessageId },
    });
    return this.prisma.message.findFirstOrThrow({
      where: { id, businessId },
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
