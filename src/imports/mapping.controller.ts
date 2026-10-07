import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ConfirmMappingDto } from './dto/confirm-mapping.dto';
import { MappingService } from './mapping.service';

@Controller('imports/:importId/mapping')
export class MappingController {
  constructor(private readonly mapping: MappingService) {}

  @Get()
  suggest(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.mapping.suggest(importId);
  }

  @Patch()
  confirm(
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Body() dto: ConfirmMappingDto,
  ) {
    return this.mapping.confirm(importId, dto);
  }
}
