import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { VariantsModule } from '../variants/variants.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ConversationsAiStore } from '../conversations/conversations-ai.store';
import { AiController } from './ai.controller';
import { AiInternalGuard } from './ai-internal.guard';
import { AiSecurity } from './ai-security';
import { AiService } from './ai.service';
import { AiConversationStore } from './ai-conversation.store';

@Module({
  imports: [
    PrismaModule,
    ProductsModule,
    VariantsModule,
    BusinessesModule,
    ConversationsModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiSecurity,
    AiInternalGuard,
    // The real store from src/conversations (was UnavailableAiConversationStore).
    { provide: AiConversationStore, useExisting: ConversationsAiStore },
  ],
  exports: [AiService],
})
export class AiModule {}
