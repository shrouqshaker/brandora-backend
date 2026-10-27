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
import { CategoriesService } from './categories.service';
import { CategoryDto } from './dto/category.dto';
import { ProductJsonBoundaryInterceptor } from '../products/product-json.interceptor';

@Controller('businesses/:businessId/categories')
@UseInterceptors(ProductJsonBoundaryInterceptor)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}
  @Post()
  create(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: CategoryDto,
  ) {
    return this.categories.create(businessId, dto);
  }
  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() page: PaginationQueryDto,
  ) {
    return this.categories.list(businessId, page);
  }
  @Get(':categoryId')
  get(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
  ) {
    return this.categories.get(businessId, id);
  }
  @Patch(':categoryId')
  update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
    @Body() dto: CategoryDto,
  ) {
    return this.categories.update(businessId, id, dto);
  }
  @Delete(':categoryId')
  @HttpCode(204)
  remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
  ) {
    return this.categories.remove(businessId, id);
  }
}
