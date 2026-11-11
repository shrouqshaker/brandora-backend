import { Module } from '@nestjs/common';
import { WhatsAppSettings } from './whatsapp-settings';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

@Module({
  controllers: [WhatsAppWebhookController],
  providers: [WhatsAppSettings],
})
export class WhatsAppModule {}