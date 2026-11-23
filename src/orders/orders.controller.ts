import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthScope, CurrentUser, Identity } from '../auth/auth-policy';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import { RejectOrderDto } from './dto/reject-order.dto';
import { OrdersService } from './orders.service';

@Controller('businesses/:businessId/orders')
@AuthScope('params')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 = made now, 200 = this message already has an order (returned as is). */
  @Post()
  async create(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @CurrentUser() user: Identity,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, created } = await this.orders.create(
      businessId,
      user.id,
      dto,
    );
    res.status(created ? 201 : 200);
    return order;
  }

  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() query: ListOrdersDto,
  ) {
    return this.orders.list(businessId, query);
  }

  @Get(':orderId')
  getOne(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.orders.getOne(businessId, orderId);
  }

  @Post(':orderId/approve')
  @HttpCode(200)
  approve(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @CurrentUser() user: Identity,
    @Body() dto: ApproveOrderDto,
  ) {
    return this.orders.approve(
      businessId,
      orderId,
      user.id,
      dto.acceptCurrentPrices === true,
    );
  }

  @Post(':orderId/reject')
  @HttpCode(200)
  reject(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.orders.reject(businessId, orderId, dto.reason);
  }
}
