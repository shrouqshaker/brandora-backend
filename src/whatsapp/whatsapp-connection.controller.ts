import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { AuthScope } from '../auth/auth-policy';
import { PutWhatsAppConnectionDto } from './dto/put-whatsapp-connection.dto';
import { WhatsAppConnectionsService } from './whatsapp-connections.service';

/** The owner links her WhatsApp business number (from Meta) to her business. */
@Controller('businesses/:businessId/whatsapp-connection')
@AuthScope('params')
export class WhatsAppConnectionController {
  constructor(private readonly connections: WhatsAppConnectionsService) {}

  @Get()
  get(@Param('businessId', new ParseUUIDPipe()) businessId: string) {
    return this.connections.get(businessId);
  }

  @Put()
  put(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: PutWhatsAppConnectionDto,
  ) {
    return this.connections.put(businessId, dto);
  }
}