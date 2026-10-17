import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { normalizePhone } from '../common/phone/normalize-phone';
import { createPagination } from '../common/pagination/pagination';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { customerSelect } from '../customers/customers.service';
import {
  ConversationChannel,
  ConversationStatus,
  MessageSenderType,
  MessageType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListConversationsDto } from './dto/list-conversations.dto';

export const messageSelect = {
  id: true,
  conversationId: true,
  senderType: true,
  externalMessageId: true,
  content: true,
  messageType: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

const conversationSelect = {
  id: true,
  businessId: true,
  customerId: true,
  channel: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, phone: true, name: true } },
} satisfies Prisma.ConversationSelect;

export interface InboundMessageInput {
  businessId: string;
  phone: string;
  name?: string | null;
  /** WhatsApp messages[].id (wamid...). Makes the call idempotent. */
  externalMessageId?: string | null;
  content: string;
  messageType?: MessageType;
}

export interface IngestResult {
  /** true when this externalMessageId was already stored; nothing was written. */
  duplicate: boolean;
  customer: Prisma.CustomerGetPayload<{ select: typeof customerSelect }>;
  conversation: Prisma.ConversationGetPayload<{
    select: typeof conversationSelect;
  }>;
  message: Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
}

const MAX_ATTEMPTS = 2;

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The single entry point for "a customer wrote to a business". The dev
   * endpoint calls it today; the WhatsApp webhook will call it later.
   * Safe to call twice with the same externalMessageId.
   */
  async ingestInboundMessage(
    input: InboundMessageInput,
  ): Promise<IngestResult> {
    const phone = normalizePhone(input.phone);
    if (!phone)
      throw new AppHttpException(
        ErrorCode.INVALID_PHONE_NUMBER,
        HttpStatus.BAD_REQUEST,
        'phone must be an international number with 8 to 15 digits, e.g. 201000000001',
      );
    const { businessId } = input;
    const externalMessageId = input.externalMessageId?.trim() || null;
    const name = input.name?.trim() || undefined;

    await this.requireBusiness(businessId);

    if (externalMessageId) {
      const existing = await this.findDuplicate(externalMessageId, businessId);
      if (existing) return existing;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const customer = await tx.customer.upsert({
            where: { businessId_phone: { businessId, phone } },
            create: { businessId, phone, name },
            update: name ? { name } : {},
            select: customerSelect,
          });
          const conversation = await tx.conversation.upsert({
            where: {
              businessId_customerId_channel: {
                businessId,
                customerId: customer.id,
                channel: ConversationChannel.WHATSAPP,
              },
            },
            create: {
              businessId,
              customerId: customer.id,
              channel: ConversationChannel.WHATSAPP,
            },
            // A new customer message reopens a closed conversation and bumps updatedAt.
            update: { status: ConversationStatus.OPEN },
            select: conversationSelect,
          });
          const message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderType: MessageSenderType.CUSTOMER,
              externalMessageId,
              content: input.content,
              messageType: input.messageType ?? MessageType.TEXT,
            },
            select: messageSelect,
          });
          return { duplicate: false, customer, conversation, message };
        });
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error;
        // Two requests raced (same wamid, or same new customer). Whoever lost
        // either finds the winner's message, or simply retries on top of it.
        if (externalMessageId) {
          const existing = await this.findDuplicate(
            externalMessageId,
            businessId,
          );
          if (existing) return existing;
        }
        if (attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  async list(businessId: string, query: ListConversationsDto) {
    await this.requireBusiness(businessId);
    const where: Prisma.ConversationWhereInput = {
      businessId,
      ...(query.status ? { status: query.status } : {}),
    };
    const totalCount = await this.prisma.conversation.count({ where });
    const rows =
      query.offset >= totalCount
        ? []
        : await this.prisma.conversation.findMany({
            where,
            select: {
              ...conversationSelect,
              messages: {
                select: messageSelect,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
              },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: query.limit,
            skip: query.offset,
          });
    const items = rows.map(({ messages, ...conversation }) => ({
      ...conversation,
      lastMessage: messages[0] ?? null,
    }));
    return { pagination: createPagination(query, totalCount), items };
  }

  async getOne(businessId: string, conversationId: string) {
    // id + businessId together: another business's conversation is "not found".
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      select: conversationSelect,
    });
    if (!conversation) throw this.conversationNotFound();
    return conversation;
  }

  /** Newest first, so offset paging returns the latest page first; clients reverse for display. */
  async listMessages(
    businessId: string,
    conversationId: string,
    pagination: PaginationQueryDto,
  ) {
    await this.getOne(businessId, conversationId);
    const where = { conversationId };
    const totalCount = await this.prisma.message.count({ where });
    const items =
      pagination.offset >= totalCount
        ? []
        : await this.prisma.message.findMany({
            where,
            select: messageSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: pagination.limit,
            skip: pagination.offset,
          });
    return { pagination: createPagination(pagination, totalCount), items };
  }

  private async findDuplicate(
    externalMessageId: string,
    businessId: string,
  ): Promise<IngestResult | null> {
    const found = await this.prisma.message.findUnique({
      where: { externalMessageId },
      select: {
        ...messageSelect,
        conversation: { select: conversationSelect },
      },
    });
    if (!found) return null;
    const { conversation, ...message } = found;
    if (conversation.businessId !== businessId)
      throw new AppHttpException(
        ErrorCode.EXTERNAL_MESSAGE_ID_CONFLICT,
        HttpStatus.CONFLICT,
        'externalMessageId already belongs to another business',
      );
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: conversation.customerId },
      select: customerSelect,
    });
    return { duplicate: true, customer, conversation, message };
  }

  private async requireBusiness(businessId: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business)
      throw new AppHttpException(
        ErrorCode.BUSINESS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Business not found',
      );
  }

  private conversationNotFound(): AppHttpException {
    return new AppHttpException(
      ErrorCode.CONVERSATION_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Conversation not found in this business',
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
