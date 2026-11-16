import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { VariantsModule } from '../variants/variants.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { AiController } from './ai.controller';
import { AiInternalGuard } from './ai-internal.guard';
import { AiSecurity } from './ai-security';
import { AiService } from './ai.service';
import {
  AiConversationStore,
  UnavailableAiConversationStore,
} from './ai-conversation.store';

@Module({
  imports: [PrismaModule, ProductsModule, VariantsModule, BusinessesModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiSecurity,
    AiInternalGuard,
    { provide: AiConversationStore, useClass: UnavailableAiConversationStore },
  ],
  exports: [AiService],
})
export class AiModule {}
