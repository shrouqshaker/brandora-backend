import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersModule } from '../customers/customers.module';
import { MessagesModule } from '../messages/messages.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsAiStore } from './conversations-ai.store';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [PrismaModule, CustomersModule, MessagesModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationsAiStore],
  exports: [ConversationsService, ConversationsAiStore],
})
export class ConversationsModule {}
