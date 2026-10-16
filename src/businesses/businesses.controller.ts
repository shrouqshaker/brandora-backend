import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';
import { PutWorkingHoursDto } from './dto/put-working-hours.dto';

@Controller('businesses')
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Post()
  create(@Body() dto: CreateBusinessDto) {
    return this.businesses.create(dto);
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
