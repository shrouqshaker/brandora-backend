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
} from '@nestjs/common';
import { AuthScope } from '../auth/auth-policy';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { BusinessFaqsService } from './business-faqs.service';
import {
  CreateBusinessFaqDto,
  UpdateBusinessFaqDto,
} from './dto/business-faq.dto';

@Controller('businesses/:businessId/faqs')
@AuthScope('params')
export class BusinessFaqsController {
  constructor(private readonly faqs: BusinessFaqsService) {}
  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() page: PaginationQueryDto,
  ) {
    return this.faqs.list(businessId, page);
  }
  @Post()
  create(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: CreateBusinessFaqDto,
  ) {
    return this.faqs.create(businessId, dto);
  }
  @Patch(':faqId')
  update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('faqId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessFaqDto,
  ) {
    return this.faqs.update(businessId, id, dto);
  }
  @Delete(':faqId')
  @HttpCode(204)
  remove(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('faqId', new ParseUUIDPipe()) id: string,
  ) {
    return this.faqs.remove(businessId, id);
  }
}
