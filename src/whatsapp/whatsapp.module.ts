import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppConnectionController } from './whatsapp-connection.controller';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';
import { WhatsAppSettings } from './whatsapp-settings';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

@Module({
  imports: [PrismaModule],
  controllers: [WhatsAppWebhookController, WhatsAppConnectionController],
  providers: [WhatsAppSettings, WhatsAppConnectionsService],
})
export class WhatsAppModule {}