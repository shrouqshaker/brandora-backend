import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';

export abstract class PasswordResetMailer {
  abstract assertReady(): void;
  abstract send(email: string, token: string): Promise<void>;
}
@Injectable()
export class SmtpPasswordResetMailer extends PasswordResetMailer {
  constructor(private readonly config: ConfigService) {
    super();
  }
  assertReady() {
    const c = this.config;
    const link = c.get<string>('AUTH_RESET_URL');
    let validLink = false;
    try {
      const parsed = new URL(link ?? '');
      validLink =
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash;
    } catch {
      /* invalid configuration */
    }
    const secure = c.get<string>('SMTP_SECURE') ?? 'false';
    const port = Number(c.get('SMTP_PORT') ?? (secure === 'true' ? 465 : 587));
    const from = c.get<string>('SMTP_FROM');
    if (
      c.get('AUTH_EMAIL_MODE') !== 'smtp' ||
      !validLink ||
      !c.get('SMTP_HOST') ||
      !c.get('SMTP_USER') ||
      !c.get('SMTP_PASSWORD') ||
      !from ||
      /[\r\n]/.test(from) ||
      !['true', 'false'].includes(secure) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new AppHttpException(
        ErrorCode.AUTH_EMAIL_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Password recovery email is not configured',
      );
  }
  async send(email: string, token: string) {
    this.assertReady();
    const secure = this.config.get('SMTP_SECURE') === 'true';
    const port = Number(this.config.get('SMTP_PORT') ?? (secure ? 465 : 587));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid SMTP configuration');
    const transport = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST'),
      port,
      secure,
      requireTLS: !secure,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASSWORD'),
      },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
    });
    // Fragments reach Android App Links without leaking tokens into HTTP access logs.
    const link = new URL(this.config.get<string>('AUTH_RESET_URL')!);
    link.hash = new URLSearchParams({ token }).toString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.sendMail({
          from: this.config.get<string>('SMTP_FROM'),
          to: email,
          subject: 'Reset your Brandora password',
          text: `A password reset was requested for your Brandora account. Open this link within 15 minutes: ${link.toString()}\nIf you did not request this, ignore this message. Your password has not changed.`,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('SMTP delivery timeout')),
            2500,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  }
}
