import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppSenderModule } from '../whatsapp/whatsapp-sender.module';
import { AiReplyService } from './ai-reply.service';

/** Customer message in -> AI (or a fixed answer) -> WhatsApp reply out. */
@Module({
  imports: [
    PrismaModule,
    AiModule,
    ConversationsModule,
    MessagesModule,
    WhatsAppSenderModule,
  ],
  providers: [AiReplyService],
  exports: [AiReplyService],
})
export class AiRepliesModule {}
