import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';
import { PutWorkingHoursDto } from './dto/put-working-hours.dto';
import { AuthScope, CurrentUser, Identity } from '../auth/auth-policy';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';

@Controller('businesses')
@AuthScope('params')
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Post()
  @AuthScope('identity')
  create(@Body() dto: CreateBusinessDto, @CurrentUser() user: Identity) {
    return this.businesses.create(dto, user.id);
  }

  @Get()
  @AuthScope('identity')
  list(@CurrentUser() user: Identity, @Query() pagination: PaginationQueryDto) {
    return this.businesses.list(user.id, pagination);
  }

  @Get(':businessId')
  get(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.get(id);
  }

  @Patch(':businessId')
  update(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businesses.update(id, dto);
  }

  @Get(':businessId/settings')
  settings(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.settings(id);
  }

  @Patch(':businessId/settings')
  updateSettings(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessSettingsDto,
  ) {
    return this.businesses.updateSettings(id, dto);
  }

  @Get(':businessId/working-hours')
  hours(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.hours(id);
  }

  @Put(':businessId/working-hours')
  putHours(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: PutWorkingHoursDto,
  ) {
    return this.businesses.putHours(id, dto);
  }
}
