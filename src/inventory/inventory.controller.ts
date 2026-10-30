import { AuthScope } from '../auth/auth-policy';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { InventoryMovementType } from '../generated/prisma/client';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { InventoryService } from './inventory.service';

@Controller('businesses/:businessId')
@AuthScope('params')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('products/:catalogItemId/variants/:variantId/inventory/adjust')
  adjust(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('catalogItemId', new ParseUUIDPipe()) catalogItemId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() dto: AdjustInventoryDto,
  ) {
    return this.inventory.setQuantity(
      { id: variantId, catalogItemId, businessId },
      dto.quantity,
      InventoryMovementType.MANUAL_ADJUSTMENT,
      undefined,
      undefined,
      dto.trackInventory !== false,
    );
  }

  @Get('products/:catalogItemId/variants/:variantId/inventory/movements')
  itemMovements(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('catalogItemId', new ParseUUIDPipe()) catalogItemId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.inventory.listVariantMovements(
      { businessId, catalogItemId, id: variantId },
      pagination,
    );
  }

  @Get('inventory/movements')
  businessMovements(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.inventory.listBusinessMovements(businessId, pagination);
  }
}
