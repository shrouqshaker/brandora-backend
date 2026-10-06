import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { ListCatalogItemsDto } from './dto/list-catalog-items.dto';

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
}
