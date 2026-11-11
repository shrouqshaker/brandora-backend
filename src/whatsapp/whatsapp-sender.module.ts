import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { WhatsAppSettings } from './whatsapp-settings';

/**
 * Sending on its own module, so conversations, AI replies and orders can all
 * send without importing the webhook module (no circular imports).
 */
@Module({
  imports: [PrismaModule, MessagesModule],
  providers: [
    WhatsAppSettings,
    WhatsAppConnectionsService,
    WhatsAppSenderService,
  ],
  exports: [
    WhatsAppSettings,
    WhatsAppConnectionsService,
    WhatsAppSenderService,
  ],
})
export class WhatsAppSenderModule {}