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
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';
import { ProductJsonBoundaryInterceptor } from './product-json.interceptor';

@Controller('businesses/:businessId/products')
@AuthScope('params')
@UseInterceptors(ProductJsonBoundaryInterceptor)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}
  @Post()
  create(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(businessId, dto);
  }
  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() page: PaginationQueryDto,
  ) {
    return this.products.list(businessId, page);
  }
  @Get(':productId')
  get(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) id: string,
  ) {
    return this.products.get(businessId, id);
  }
  @Patch(':productId')
  update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(businessId, id, dto);
  }
  @Delete(':productId')
  @HttpCode(204)
  remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('productId', new ParseUUIDPipe()) id: string,
  ) {
    return this.products.remove(businessId, id);
  }
}
