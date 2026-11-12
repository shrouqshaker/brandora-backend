import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import {
  characterCount,
  MESSAGE_MAX_CHARACTERS,
} from '../messages/message-limits';
import {
  MessagesService,
  messageSelect,
  MessageView,
} from '../messages/messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { maskPhone } from './mask-phone';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';
import { WhatsAppSettings } from './whatsapp-settings';

/**
 * The only place that sends WhatsApp messages. Order: store PENDING -> send
 * -> SENT (with WhatsApp's id) or FAILED. So there is always a record, even
 * when Meta says no. Meta problems never throw: the message becomes FAILED.
 */
@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger('WhatsAppSender');

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly connections: WhatsAppConnectionsService,
    private readonly settings: WhatsAppSettings,
  ) {}

  /** A new AI or owner message: store it, then send it. */
  async send(input: {
    businessId: string;
    conversationId: string;
    senderType: 'AI' | 'OWNER';
    content: string;
    aiMeta?: Prisma.InputJsonValue;
  }): Promise<MessageView> {
    const message = await this.messages.createOutbound(input);
    return this.deliver(input.businessId, message.id);
  }

  /** Sends a message that is already stored as PENDING. Safe to call twice. */
  async deliver(businessId: string, messageId: string): Promise<MessageView> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, businessId },
      select: {
        ...messageSelect,
        conversation: { select: { customer: { select: { phone: true } } } },
      },
    });
    if (!message) throw new Error(`Message ${messageId} not found`);
    const { conversation, ...view } = message;
    if (view.status !== 'PENDING') return view; // sent (or failed) before

    let result: { externalMessageId: string } | 'FAILED' = 'FAILED';
    const phone = conversation.customer.phone;
    try {
      const from = await this.connections.activePhoneNumberIdFor(businessId);
      if (!from) throw new Error('no active WhatsApp number for this business');
      if (characterCount(view.content) > MESSAGE_MAX_CHARACTERS)
        throw new Error(`longer than ${MESSAGE_MAX_CHARACTERS} characters`);
      result = {
        externalMessageId: await this.post(from, phone, view.content),
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Message to ${maskPhone(phone)} not sent: ${reason}`);
    }
    return this.messages.markSendResult(businessId, view.id, result);
  }

  /** One text message through Meta's Cloud API. Returns WhatsApp's id (wamid). */
  private async post(
    phoneNumberId: string,
    to: string,
    body: string,
  ): Promise<string> {
    const { dryRun, accessToken, graphVersion } = this.settings.sending();
    if (dryRun) {
      this.logger.log(
        `[dry run] ${characterCount(body)} characters to ${maskPhone(to)}`,
      );
      return `dryrun-${randomUUID()}`;
    }
    const response = await fetch(
      `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        }),
      },
    );
    const json = (await response.json().catch(() => ({}))) as {
      messages?: { id?: unknown }[];
      error?: { code?: unknown; message?: unknown };
    };
    const id = json.messages?.[0]?.id;
    if (!response.ok || typeof id !== 'string')
      throw new Error(
        `Meta answered ${response.status} (${String(json.error?.code ?? '')}) ${String(json.error?.message ?? '')}`.trim(),
      );
    return id;
  }
}
