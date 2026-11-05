import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';

export abstract class PasswordResetMailer {
  abstract assertReady(): void;
  abstract send(email: string, otp: string): Promise<void>;
}

@Injectable()
export class BrevoPasswordResetMailer extends PasswordResetMailer {
  constructor(private readonly config: ConfigService) {
    super();
  }

  assertReady() {
    const c = this.config;
    const from = c.get<string>('BREVO_SENDER_EMAIL');
    const apiKey = c.get<string>('BREVO_API_KEY') ?? '';
    const mode = c.get<string>('AUTH_EMAIL_MODE');
    if (
      mode !== 'brevo' ||
      !/^[\x21-\x7e]+$/.test(apiKey.trim()) ||
      /[\r\n]/.test(apiKey) ||
      !from ||
      !isEmail(from.trim()) ||
      /[\r\n]/.test(from)
    )
      throw new AppHttpException(
        ErrorCode.AUTH_EMAIL_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Password recovery email is not configured',
      );
  }

  async send(email: string, otp: string) {
    this.assertReady();
    if (typeof otp !== 'string' || otp.length !== 8 || !/^[0-9]{8}$/.test(otp))
      throw new Error('Brevo email delivery failed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'api-key': this.config.get<string>('BREVO_API_KEY')!.trim(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: {
            email: this.config.get<string>('BREVO_SENDER_EMAIL')!.trim(),
          },
          to: [{ email }],
          subject: 'Reset your Brandora password',
          textContent: `Your Brandora password reset code is: ${otp}\nEnter this code in the app within 15 minutes. Do not share it with anyone.\nIf you did not request this, ignore this message. Your password has not changed.`,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Brevo email delivery failed');
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('messageId' in result) ||
        typeof result.messageId !== 'string' ||
        !result.messageId.trim()
      )
        throw new Error('Brevo email delivery failed');
    } catch {
      // Provider and network errors may contain request details. Never propagate them.
      throw new Error('Brevo email delivery failed');
    } finally {
      clearTimeout(timer);
      // Also release the response body/socket on a provider error.
      controller.abort();
    }
  }
}
