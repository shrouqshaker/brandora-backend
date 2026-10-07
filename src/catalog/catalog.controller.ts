import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { ListCatalogItemsDto } from './dto/list-catalog-items.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { CatalogItemScopeDto } from './dto/catalog-item-scope.dto';

@Controller('catalog-items')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Post()
  create(@Body() dto: CreateCatalogItemDto) {
    return this.catalog.create(dto);
  }

  @Get()
  list(@Query() query: ListCatalogItemsDto) {
    return this.catalog.list(query);
  }

  @Get(':catalogItemId')
  getOne(
    @Param('catalogItemId', new ParseUUIDPipe()) id: string,
    @Query() query: CatalogItemScopeDto,
  ) {
    return this.catalog.getOne(id, query.businessId);
  }

  @Patch(':catalogItemId')
  update(
    @Param('catalogItemId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCatalogItemDto,
  ) {
    return this.catalog.update(id, dto);
  }

  @Delete(':catalogItemId')
  deactivate(
    @Param('catalogItemId', new ParseUUIDPipe()) id: string,
    @Query() query: CatalogItemScopeDto,
  ) {
    return this.catalog.deactivate(id, query.businessId);
  }
}
