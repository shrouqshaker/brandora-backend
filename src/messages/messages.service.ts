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

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** A customer message. Runs inside the caller's transaction. */
  createInbound(
    tx: Prisma.TransactionClient,
    data: {
      businessId: string;
      conversationId: string;
      externalMessageId: string | null;
      content: string;
      messageType: MessageType;
    },
  ) {
    return tx.message.create({
      data: {
        ...data,
        senderType: MessageSenderType.CUSTOMER,
        status: MessageDeliveryStatus.RECEIVED,
      },
      select: messageSelect,
    });
  }

  /** An AI or owner message, stored as PENDING before it is sent. */
  createOutbound(data: {
    businessId: string;
    conversationId: string;
    senderType: 'AI' | 'OWNER';
    content: string;
    aiMeta?: Prisma.InputJsonValue;
  }) {
    return this.prisma.message.create({
      data: { ...data, status: MessageDeliveryStatus.PENDING },
      select: messageSelect,
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

  /** The last `limit` messages, oldest first (for the AI context). */
  async recentHistory(businessId: string, conversationId: string, limit = 20) {
    const newestFirst = await this.prisma.message.findMany({
      where: { businessId, conversationId },
      select: { senderType: true, content: true, aiMeta: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return newestFirst.reverse();
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
}
