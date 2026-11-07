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

/** Order of delivery states. A status update never moves a message backwards. */
const STATUS_RANK: Record<MessageDeliveryStatus, number> = {
  RECEIVED: 0,
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4,
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

  /** After the send attempt: SENT with WhatsApp's id, or FAILED. */
  markSendResult(id: string, result: { externalMessageId: string } | 'FAILED') {
    return this.prisma.message.update({
      where: { id },
      data:
        result === 'FAILED'
          ? { status: MessageDeliveryStatus.FAILED }
          : {
              status: MessageDeliveryStatus.SENT,
              externalMessageId: result.externalMessageId,
            },
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

  /** From a WhatsApp status webhook (sent / delivered / read / failed). */
  async updateDeliveryStatus(
    externalMessageId: string,
    status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
  ): Promise<boolean> {
    const message = await this.prisma.message.findUnique({
      where: { externalMessageId },
      select: { id: true, status: true },
    });
    if (!message || STATUS_RANK[status] <= STATUS_RANK[message.status])
      return false;
    await this.prisma.message.update({
      where: { id: message.id },
      data: { status },
    });
    return true;
  }
}