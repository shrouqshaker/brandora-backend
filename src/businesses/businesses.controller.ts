import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
} from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';
import { PutWorkingHoursDto } from './dto/put-working-hours.dto';

@Controller('businesses/:businessId')
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Get()
  get(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.get(id);
  }

  @Patch()
  update(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businesses.update(id, dto);
  }

  @Get('settings')
  settings(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.settings(id);
  }

  @Patch('settings')
  updateSettings(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBusinessSettingsDto,
  ) {
    return this.businesses.updateSettings(id, dto);
  }

  @Get('working-hours')
  hours(@Param('businessId', new ParseUUIDPipe()) id: string) {
    return this.businesses.hours(id);
  }

  @Put('working-hours')
  putHours(
    @Param('businessId', new ParseUUIDPipe()) id: string,
    @Body() dto: PutWorkingHoursDto,
  ) {
    return this.businesses.putHours(id, dto);
  }
}
