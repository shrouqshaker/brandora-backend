import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';

/** 503: WhatsApp is switched off, or one of its settings is missing. */
export const whatsAppUnavailable = () =>
  new AppHttpException(
    ErrorCode.WHATSAPP_UNAVAILABLE,
    HttpStatus.SERVICE_UNAVAILABLE,
    'WhatsApp integration is not available',
  );

/** Same answer as a === b, but always takes the same time (no timing leak). */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/** Printable characters only, no spaces, 16 or more. */
const SECRET = /^[\x21-\x7e]{16,4096}$/;

/**
 * The only place that reads WhatsApp settings from .env.
 * Off unless WHATSAPP_ENABLED="true", like AI_INTEGRATION_ENABLED in src/ai.
 */
@Injectable()
export class WhatsAppSettings {
  constructor(private readonly config: ConfigService) {}

  private requireEnabled(): void {
    if (this.config.get<string>('WHATSAPP_ENABLED') !== 'true')
      throw whatsAppUnavailable();
  }

  private secret(name: string): string {
    this.requireEnabled();
    const value = this.config.get<string>(name) ?? '';
    if (!SECRET.test(value)) throw whatsAppUnavailable();
    return value;
  }

  /** The word Meta sends back when it checks the webhook URL (GET). */
  verifyToken(): string {
    return this.secret('WHATSAPP_VERIFY_TOKEN');
  }

  /** Meta signs every POST with this secret. */
  appSecret(): string {
    return this.secret('WHATSAPP_APP_SECRET');
  }

  /** For sending. In dry run no token is needed: nothing leaves the server. */
  sending(): { dryRun: boolean; accessToken: string; graphVersion: string } {
    this.requireEnabled();
    const dryRun = this.config.get<string>('WHATSAPP_DRY_RUN') !== 'false';
    const graphVersion =
      this.config.get<string>('WHATSAPP_GRAPH_VERSION') ?? 'v26.0';
    if (!/^v\d{1,3}\.\d$/.test(graphVersion)) throw whatsAppUnavailable();
    return {
      dryRun,
      accessToken: dryRun ? '' : this.secret('WHATSAPP_ACCESS_TOKEN'),
      graphVersion,
    };
  }
}