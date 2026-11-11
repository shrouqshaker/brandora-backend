import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InboundWebhookService } from './inbound-webhook.service';
import { WhatsAppConnectionController } from './whatsapp-connection.controller';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';
import { WhatsAppSettings } from './whatsapp-settings';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

@Module({
  imports: [PrismaModule, ConversationsModule, MessagesModule],
  controllers: [WhatsAppWebhookController, WhatsAppConnectionController],
  providers: [
    WhatsAppSettings,
    WhatsAppConnectionsService,
    InboundWebhookService,
  ],
})
export class WhatsAppModule {}