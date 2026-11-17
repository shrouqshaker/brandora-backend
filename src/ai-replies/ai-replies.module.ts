import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppSenderModule } from '../whatsapp/whatsapp-sender.module';
import { AiReplyService } from './ai-reply.service';
import { LoggingOwnerNotifier, OWNER_NOTIFIER } from './owner-notifier';

/** Customer message in -> AI (or a fixed answer) -> WhatsApp reply out. */
@Module({
  imports: [
    PrismaModule,
    AiModule,
    ConversationsModule,
    MessagesModule,
    WhatsAppSenderModule,
  ],
  providers: [
    AiReplyService,
    // Replace with the push-notification service when it exists (useExisting).
    { provide: OWNER_NOTIFIER, useClass: LoggingOwnerNotifier },
  ],
  exports: [AiReplyService],
})
export class AiRepliesModule {}
