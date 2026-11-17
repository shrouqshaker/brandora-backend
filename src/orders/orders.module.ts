import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { VariantsModule } from '../variants/variants.module';
import { WhatsAppSenderModule } from '../whatsapp/whatsapp-sender.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    PrismaModule,
    ProductsModule,
    VariantsModule,
    InventoryModule,
    WhatsAppSenderModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
