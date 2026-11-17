import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { VariantsModule } from '../variants/variants.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PrismaModule, ProductsModule, VariantsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
