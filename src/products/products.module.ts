import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductAccessService } from './product-access.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryService } from './images/cloudinary.service';
import { ProductImagesService } from './images/product-images.service';
import { ProductImagesController } from './images/product-images.controller';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [ProductsController, ProductImagesController],
  providers: [
    ProductsService,
    ProductAccessService,
    CloudinaryService,
    ProductImagesService,
  ],
  exports: [ProductAccessService, ProductsService],
})
export class ProductsModule {}
