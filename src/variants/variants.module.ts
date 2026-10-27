import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';

@Module({
  imports: [PrismaModule, ProductsModule],
  controllers: [VariantsController],
  providers: [VariantsService],
})
export class VariantsModule {}
