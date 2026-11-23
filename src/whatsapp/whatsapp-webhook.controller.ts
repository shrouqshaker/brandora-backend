import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiReplyService } from '../ai-replies/ai-reply.service';
import { AuthScope } from '../auth/auth-policy';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { sameSecret, WhatsAppSettings } from './whatsapp-settings';
import { InboundWebhookService } from './inbound-webhook.service';
import { isValidWhatsAppSignature } from './whatsapp-signature';

/** Called by Meta, not by the mobile app. */
@Controller('webhooks/whatsapp')
@AuthScope('public')
export class WhatsAppWebhookController {
  constructor(
    private readonly settings: WhatsAppSettings,
    private readonly inbound: InboundWebhookService,
    private readonly replies: AiReplyService,
  ) {}

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
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ received: true }> {
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
    // Store first, answer second: a 200 means "it is safe in our database".
    const stored = await this.inbound.store(req.body);
    // Replies run in the background, after Meta has its 200
    // (the AI can take seconds; Meta does not wait that long).
    // Repeats too: answer() skips a message that is answered or in progress.
    for (const turn of stored) void this.replies.answer(turn);
    return { received: true };
  }
}
