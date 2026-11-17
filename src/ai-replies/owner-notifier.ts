import { Injectable, Logger } from '@nestjs/common';

/** Events the shop owner must hear about. */
export interface OwnerNotifier {
  /** The customer wants to buy (PURCHASE_INTENT). */
  purchaseIntent(businessId: string, conversationId: string): Promise<void>;
  /** The AI stopped; the owner answers this conversation. */
  handoffRequested(
    businessId: string,
    conversationId: string,
    reason: string,
  ): Promise<void>;
}

export const OWNER_NOTIFIER = Symbol('OWNER_NOTIFIER');

/** Default until push notifications exist: logs ids only, no customer data. */
@Injectable()
export class LoggingOwnerNotifier implements OwnerNotifier {
  private readonly logger = new Logger('OwnerNotifier');

  async purchaseIntent(businessId: string, conversationId: string) {
    this.logger.log(
      `Purchase intent in conversation ${conversationId} (business ${businessId})`,
    );
  }

  async handoffRequested(
    businessId: string,
    conversationId: string,
    reason: string,
  ) {
    this.logger.log(
      `Handoff ${reason} in conversation ${conversationId} (business ${businessId})`,
    );
  }
}
