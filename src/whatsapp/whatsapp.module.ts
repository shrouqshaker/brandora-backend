import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { InboundWebhookService } from './inbound-webhook.service';
import { WhatsAppConnectionController } from './whatsapp-connection.controller';
import { WhatsAppSenderModule } from './whatsapp-sender.module';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

@Module({
  imports: [ConversationsModule, MessagesModule, WhatsAppSenderModule],
  controllers: [WhatsAppWebhookController, WhatsAppConnectionController],
  providers: [InboundWebhookService],
})
export class WhatsAppModule {}
