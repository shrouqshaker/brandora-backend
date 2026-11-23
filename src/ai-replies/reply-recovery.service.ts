import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeError } from '../common/logging/safe-error';
import {
  AI_LEASE_MS,
  AI_MAX_ATTEMPTS,
  SEND_LEASE_MS,
  SEND_MAX_ATTEMPTS,
} from '../messages/messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service';
import { AiReplyService } from './ai-reply.service';

/** Only this recent is answered or sent automatically after a stop. */
export const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
/** Younger than this, the normal path (the webhook) is still on it. */
const GRACE_MS = 10 * 1000;
const BATCH = 50;

export interface RecoveryResult {
  /** PENDING messages given up: a send that never ended, or too late. */
  failed: number;
  /** Customer messages that had no reply and were answered now. */
  answered: number;
  /** Our messages sent now: never tried, or due for another try. */
  sent: number;
}

/**
 * Finishes what a stop or a crash interrupted, from what is in the database,
 * so a restart never loses a reply and never sends one twice. Runs when the
 * server starts, then every REPLY_RECOVERY_SECONDS (30; "0" = off).
 *
 * 1) A send that started and never ended: Meta may have sent it, so it is
 *    never sent again. It becomes FAILED and the owner sees it. The same for
 *    anything still PENDING after the 15-minute window.
 * 2) Customer messages of the last 15 minutes with no reply: answered.
 * 3) Our PENDING messages never sent, or due for another try: sent.
 *
 * An automatic answer (2, and AI replies in 3) only goes out while it is the
 * newest message of its chat: if the customer or the owner wrote since, an
 * old answer would only confuse. The owner's own messages are always sent.
 */
@Injectable()
export class ReplyRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('ReplyRecovery');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly replies: AiReplyService,
    private readonly sender: WhatsAppSenderService,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = Number(
      this.config.get<string>('REPLY_RECOVERY_SECONDS') ?? '30',
    );
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), seconds * 1000);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass. Never throws. Public so tests can run it like a restart. */
  async sweep(): Promise<RecoveryResult> {
    const done: RecoveryResult = { failed: 0, answered: 0, sent: 0 };
    if (this.running || this.config.get<string>('WHATSAPP_ENABLED') !== 'true')
      return done;
    this.running = true;
    try {
      const now = Date.now();
      const windowStart = new Date(now - RECOVERY_WINDOW_MS);
      const settled = new Date(now - GRACE_MS);

      // 1) Never send again after an interrupted send, and never very late.
      const given = await this.prisma.message.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { sendClaimedAt: { lt: new Date(now - SEND_LEASE_MS) } },
            { sendClaimedAt: null, createdAt: { lt: windowStart } },
          ],
        },
        data: { status: 'FAILED', sendClaimedAt: null },
      });
      done.failed = given.count;

      // 2) Customer messages with no reply: the server stopped before the AI.
      if (this.config.get<string>('AI_INTEGRATION_ENABLED') === 'true') {
        const waiting = await this.prisma.message.findMany({
          where: {
            senderType: 'CUSTOMER',
            status: 'RECEIVED',
            createdAt: { gte: windowStart, lte: settled },
            aiAttempts: { lt: AI_MAX_ATTEMPTS },
            OR: [
              { aiClaimedAt: null },
              { aiClaimedAt: { lt: new Date(now - AI_LEASE_MS) } },
            ],
            conversation: { aiEnabled: true },
          },
          select: {
            id: true,
            businessId: true,
            conversationId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        });
        const replied = await this.prisma.message.findMany({
          where: { replyToMessageId: { in: waiting.map((m) => m.id) } },
          select: { replyToMessageId: true },
        });
        const has = new Set(replied.map((r) => r.replyToMessageId));
        for (const m of waiting.filter((w) => !has.has(w.id))) {
          if (!(await this.isNewest(m))) continue;
          await this.replies.answer({
            businessId: m.businessId,
            conversationId: m.conversationId,
            messageId: m.id,
          });
          done.answered++;
        }
      }

      // 3) Our messages stored but not sent: never tried, or due again.
      const unsent = await this.prisma.message.findMany({
        where: {
          status: 'PENDING',
          sendClaimedAt: null,
          sendAttempts: { lt: SEND_MAX_ATTEMPTS },
          createdAt: { gte: windowStart },
          OR: [
            { sendAttempts: 0, createdAt: { lte: settled } },
            { sendAttempts: { gt: 0 }, nextSendAt: { lte: new Date(now) } },
          ],
        },
        select: {
          id: true,
          businessId: true,
          conversationId: true,
          senderType: true,
          replyToMessageId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      for (const m of unsent) {
        // An AI reply goes back through AiReplyService, so a handoff or an
        // owner alert that the stop interrupted also happens.
        if (m.senderType === 'AI' && m.replyToMessageId) {
          if (!(await this.isNewest(m))) continue; // FAILED after the window
          await this.replies.answer({
            businessId: m.businessId,
            conversationId: m.conversationId,
            messageId: m.replyToMessageId,
          });
        } else
          await this.sender
            .deliver(m.businessId, m.id)
            .catch((error: unknown) =>
              this.logger.warn(`Could not send ${m.id}: ${safeError(error)}`),
            );
        done.sent++;
      }

      if (done.failed || done.answered || done.sent)
        this.logger.log(
          `Recovered: ${done.answered} answered, ${done.sent} sent, ${done.failed} given up`,
        );
    } catch (error: unknown) {
      this.logger.error(`Recovery pass stopped: ${safeError(error)}`);
    } finally {
      this.running = false;
    }
    return done;
  }

  /** Nothing was written in this chat after this message. */
  private async isNewest(m: {
    id: string;
    businessId: string;
    conversationId: string;
    createdAt: Date;
  }): Promise<boolean> {
    const later = await this.prisma.message.findFirst({
      where: {
        businessId: m.businessId,
        conversationId: m.conversationId,
        id: { not: m.id },
        createdAt: { gte: m.createdAt },
      },
      select: { id: true },
    });
    return !later;
  }
}
