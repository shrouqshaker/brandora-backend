import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AuthScope } from '../../auth/auth-policy';
import {
  ProductImageDto,
  ProductImageMainDto,
  ProductImageOrderDto,
} from './product-image.dto';
import { ErrorCode } from '../../common/errors/error-code';
import { fail } from '../product-access.service';
import { HttpStatus } from '@nestjs/common';
import { ProductImageUploadInterceptor } from './product-image-upload.interceptor';
import { ProductImagesService } from './product-images.service';

@Controller('businesses/:businessId/products/:productId/images')
@AuthScope('params')
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.images.list(businessId, productId);
  }

  @Post()
  @UseInterceptors(ProductImageUploadInterceptor)
  upload(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: ProductImageDto,
    @UploadedFiles()
    files?: { file?: Express.Multer.File[]; files?: Express.Multer.File[] },
  ) {
    if (files?.file?.length && files?.files?.length)
      fail(
        ErrorCode.PRODUCT_IMAGE_INVALID,
        HttpStatus.BAD_REQUEST,
        'Use file or files, not both',
      );
    return files?.files
      ? this.images.uploadBatch(businessId, productId, dto, files.files)
      : this.images.upload(businessId, productId, dto, files?.file?.[0]);
  }

  @Patch()
  reorder(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: ProductImageOrderDto,
  ) {
    return this.images.reorder(businessId, productId, dto.imageIds);
  }

  @Patch(':imageId')
  main(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('imageId', new ParseUUIDPipe()) imageId: string,
    @Body() _dto: ProductImageMainDto,
  ) {
    return this.images.setMain(businessId, productId, imageId);
  }

  @Delete(':imageId')
  remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('imageId', new ParseUUIDPipe()) imageId: string,
  ) {
    return this.images.remove(businessId, productId, imageId);
  }
}
