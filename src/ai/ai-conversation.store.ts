import { Injectable } from '@nestjs/common';
import { AiResponse } from './ai-response';
import { unavailable } from './ai-security';

export interface AiMessage {
  businessId: string;
  customerId: string;
  conversationId: string;
  messageId: string;
  message: string;
  createdAt: string;
  senderType: 'CUSTOMER';
  messageType: 'TEXT';
}

// Integration seam only: the conversations team owns persistence. Its adapter
// must attest all identities, immutable turn ordering and idempotent reply writes.
export abstract class AiConversationStore {
  abstract current(
    businessId: string,
    conversationId: string,
    messageId: string,
  ): Promise<AiMessage>;
  abstract historyBefore(
    message: AiMessage,
    limit: number,
    offset: number,
  ): Promise<unknown>;
  abstract saveReply(
    message: AiMessage,
    response: AiResponse,
  ): Promise<AiResponse>;
}

@Injectable()
export class UnavailableAiConversationStore extends AiConversationStore {
  async current(): Promise<AiMessage> {
    throw unavailable('Conversation integration is not available');
  }
  async historyBefore(): Promise<unknown> {
    throw unavailable('Conversation integration is not available');
  }
  async saveReply(): Promise<AiResponse> {
    throw unavailable('Conversation integration is not available');
  }
}
