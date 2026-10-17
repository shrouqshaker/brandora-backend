import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { CustomersService } from './customers.service';

@Controller('businesses/:businessId/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.customers.list(businessId, pagination);
  }

  @Get(':customerId')
  getOne(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ) {
    return this.customers.getOne(businessId, customerId);
  }
}
