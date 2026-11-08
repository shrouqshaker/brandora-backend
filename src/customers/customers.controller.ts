import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { CustomersService } from './customers.service';
import { AuthScope } from '../auth/auth-policy';

@Controller('businesses/:businessId/customers')
@AuthScope('params')
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
