import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthScope } from '../auth/auth-policy';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { sameSecret, WhatsAppSettings } from './whatsapp-settings';
import { isValidWhatsAppSignature } from './whatsapp-signature';

/** Called by Meta, not by the mobile app. */
@Controller('webhooks/whatsapp')
@AuthScope('public') // Meta has no Brandora JWT; each handler checks Meta's own proof.
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly settings: WhatsAppSettings) {}

  /** Meta asks "is this URL yours?" once, when the webhook is saved. */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const expected = this.settings.verifyToken();
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      sameSecret(token, expected) &&
      typeof challenge === 'string' &&
      /^[A-Za-z0-9_-]{1,200}$/.test(challenge)
    ) {
      res.type('text/plain'); // Meta wants the number back as plain text
      return challenge;
    }
    throw new AppHttpException(
      ErrorCode.WHATSAPP_VERIFY_TOKEN_INVALID,
      HttpStatus.FORBIDDEN,
      'Webhook verification failed',
    );
  }

  /** Every customer message and delivery report arrives here. */
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ): { received: true } {
    if (
      !isValidWhatsAppSignature(
        req.rawBody,
        signature,
        this.settings.appSecret(),
      )
    )
      throw new AppHttpException(
        ErrorCode.WHATSAPP_SIGNATURE_INVALID,
        HttpStatus.UNAUTHORIZED,
        'Invalid webhook signature',
      );
    // For now just show that it arrived.
    this.logger.log('Signed webhook received');
    return { received: true };
  }
}