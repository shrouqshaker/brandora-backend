import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersModule } from '../customers/customers.module';
import { MessagesModule } from '../messages/messages.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { DevInboundController } from './dev-inbound.controller';

@Module({
  imports: [PrismaModule, CustomersModule, MessagesModule],
  controllers: [ConversationsController, DevInboundController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
