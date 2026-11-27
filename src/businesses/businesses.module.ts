import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsModule } from '../products/products.module';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { BusinessFaqsService } from './business-faqs.service';
import { BusinessFaqsController } from './business-faqs.controller';
import { BusinessLogoService } from './business-logo.service';
import { BusinessLogoController } from './business-logo.controller';

@Module({
  imports: [PrismaModule, ProductsModule],
  controllers: [
    BusinessesController,
    BusinessFaqsController,
    BusinessLogoController,
  ],
  providers: [BusinessesService, BusinessFaqsService, BusinessLogoService],
  exports: [BusinessesService],
})
export class BusinessesModule {}
