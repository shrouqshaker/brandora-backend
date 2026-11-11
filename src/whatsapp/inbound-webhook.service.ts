import { Injectable, Logger } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { maskPhone } from './mask-phone';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';
import { parseWhatsAppWebhook } from './whatsapp-payload';

/**
 * Our own errors that the same webhook would hit again on every retry:
 * a bad number, a business that is gone, a wamid owned by another business.
 * Only these are skipped. Anything else (database down, a race that says
 * "retry") is thrown, so Meta gets a 500 and sends the webhook again.
 */
const SKIP_FOR_GOOD = new Set<string>([
  ErrorCode.INVALID_PHONE_NUMBER,
  ErrorCode.BUSINESS_NOT_FOUND,
  ErrorCode.EXTERNAL_MESSAGE_ID_CONFLICT,
]);

/** A customer message that was stored just now (not a repeat). */
export interface StoredInbound {
  businessId: string;
  conversationId: string;
  messageId: string;
}

/** Stores what Meta sent: customer messages and reports about our messages. */
@Injectable()
export class InboundWebhookService {
  private readonly logger = new Logger('WhatsAppInbound');

  constructor(
    private readonly connections: WhatsAppConnectionsService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  /**
   * Runs BEFORE we answer Meta. If the database is down this throws, Meta
   * gets a 500 and sends the webhook again later. That is safe: a repeated
   * wamid is stored once (ingestInboundMessage is idempotent).
   */
  async store(payload: unknown): Promise<StoredInbound[]> {
    const { messages, statuses } = parseWhatsAppWebhook(payload);
    const stored: StoredInbound[] = [];

    for (const m of messages) {
      const businessId = await this.connections.activeBusinessFor(
        m.phoneNumberId,
      );
      if (!businessId) {
        this.logger.warn(
          `No active business for number ${m.phoneNumberId}; message skipped`,
        );
        continue;
      }
      try {
        const result = await this.conversations.ingestInboundMessage({
          businessId,
          phone: m.from,
          name: m.profileName,
          externalMessageId: m.externalMessageId,
          content: m.content,
          messageType: m.messageType,
        });
        if (result.duplicate) {
          this.logger.log(`Duplicate ${m.externalMessageId} ignored`);
          continue;
        }
        stored.push({
          businessId,
          conversationId: result.conversation.id,
          messageId: result.message.id,
        });
      } catch (error: unknown) {
        // Retrying cannot fix these (see SKIP_FOR_GOOD): log and move on.
        if (
          !(error instanceof AppHttpException) ||
          !SKIP_FOR_GOOD.has(error.code)
        )
          throw error;
        this.logger.warn(
          `Message from ${maskPhone(m.from)} skipped: ${error.code}`,
        );
      }
    }

    for (const s of statuses) {
      const businessId = await this.connections.activeBusinessFor(
        s.phoneNumberId,
      );
      if (!businessId) continue;
      const changed = await this.messages.updateDeliveryStatus(
        businessId,
        s.externalMessageId,
        s.status,
      );
      if (s.status === 'FAILED')
        this.logger.warn(
          `Meta could not deliver ${s.externalMessageId} (error ${s.errorCode ?? 'unknown'})`,
        );
      else if (!changed)
        this.logger.debug(
          `Status ${s.status} for ${s.externalMessageId} ignored (older or unknown)`,
        );
    }
    return stored;
  }
}