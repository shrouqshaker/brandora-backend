import { AuthScope } from '../auth/auth-policy';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { VariantsService } from './variants.service';
import { ProductJsonBoundaryInterceptor } from '../products/product-json.interceptor';

@Controller('businesses/:businessId/products/:productId/variants')
@AuthScope('params')
@UseInterceptors(ProductJsonBoundaryInterceptor)
export class VariantsController {
  constructor(private readonly variants: VariantsService) {}
  @Post()
  create(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.variants.create(businessId, productId, dto);
  }
  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query() page: PaginationQueryDto,
  ) {
    return this.variants.list(businessId, productId, page);
  }
  @Get(':variantId')
  get(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('variantId', new ParseUUIDPipe()) id: string,
  ) {
    return this.variants.get(businessId, productId, id);
  }
  @Patch(':variantId')
  update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('variantId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.variants.update(businessId, productId, id, dto);
  }
  @Delete(':variantId')
  @HttpCode(204)
  remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('variantId', new ParseUUIDPipe()) id: string,
  ) {
    return this.variants.remove(businessId, productId, id);
  }
}
