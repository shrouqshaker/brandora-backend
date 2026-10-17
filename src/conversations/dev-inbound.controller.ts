import {
  Body,
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ConversationsService } from './conversations.service';
import { InboundMessageDto } from './dto/inbound-message.dto';

/**
 * TEMPORARY, development only. Simulates "a customer sent a WhatsApp message"
 * until the real webhook exists. Off unless ENABLE_DEV_ENDPOINTS=true, and it
 * answers 404 (as if the route did not exist) when off.
 * Delete this file (and its line in conversations.module.ts) with the webhook work.
 */
@Controller('businesses/:businessId/dev')
export class DevInboundController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly config: ConfigService,
  ) {}

  @Post('inbound-message')
  async inbound(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: InboundMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (this.config.get<string>('ENABLE_DEV_ENDPOINTS') !== 'true')
      throw new AppHttpException(
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Not Found',
      );
    const result = await this.conversations.ingestInboundMessage({
      businessId,
      ...dto,
    });
    // 201 = stored now, 200 = this externalMessageId was already stored.
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }
}
