import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { AuthService } from '../../src/auth/auth.service';
import { AuthSessionsService } from '../../src/auth/auth-sessions.service';
import { SmtpPasswordResetMailer } from '../../src/auth/password-reset.mailer';
import { opaqueToken } from '../../src/auth/auth-tokens';
import { PrismaService } from '../../src/prisma/prisma.service';

// Non-secret fixtures only. Every SMTP transport is mocked, including failures.
const settings = {
  AUTH_EMAIL_MODE: 'smtp',
  AUTH_RESET_URL: 'https://reset.example.invalid/auth/reset-password',
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'resend',
  SMTP_PASSWORD: 'dummy-smtp-password-not-an-api-key',
  SMTP_FROM: 'onboarding@resend.dev',
};

describe('Resend development SMTP configuration (no network)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses implicit TLS on 465, validates certificates and sends only to the requested recipient', async () => {
    const transport = {
      sendMail: jest.fn().mockResolvedValue({}),
      close: jest.fn(),
    };
    const create = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue(
        transport as unknown as ReturnType<typeof nodemailer.createTransport>,
      );
    const token = opaqueToken().value;
    await new SmtpPasswordResetMailer(new ConfigService(settings)).send(
      'account-owner@example.invalid',
      token,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'resend', pass: settings.SMTP_PASSWORD },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
    });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const message = transport.sendMail.mock.calls[0][0];
    expect(message).toMatchObject({
      from: 'onboarding@resend.dev',
      to: 'account-owner@example.invalid',
    });
    expect(message.text).toContain(`${settings.AUTH_RESET_URL}#token=${token}`);
    expect(message.text).not.toContain('?token=');
    expect(message.text).not.toContain(settings.SMTP_PASSWORD);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing new SMTP password before opening a transport', async () => {
    const create = jest
      .spyOn(nodemailer, 'createTransport')
      .mockImplementation(() => {
        throw new Error('Unexpected SMTP transport');
      });
    const mailer = new SmtpPasswordResetMailer(
      new ConfigService({ ...settings, SMTP_PASSWORD: '' }),
    );
    await expect(
      mailer.send('account-owner@example.invalid', opaqueToken().value),
    ).rejects.toMatchObject({ code: 'AUTH_EMAIL_UNAVAILABLE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the example disabled until explicitly enabled', () => {
    const create = jest
      .spyOn(nodemailer, 'createTransport')
      .mockImplementation(() => {
        throw new Error('Unexpected SMTP transport');
      });
    expect(() =>
      new SmtpPasswordResetMailer(
        new ConfigService({ ...settings, AUTH_EMAIL_MODE: 'disabled' }),
      ).assertReady(),
    ).toThrow('not configured');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    'http://reset.example.invalid/auth/reset-password',
    'brandora://reset-password',
    'https://reset.example.invalid/auth/reset-password#preset',
  ])('rejects unsupported or prepopulated reset URL %s', (url) => {
    expect(() =>
      new SmtpPasswordResetMailer(
        new ConfigService({ ...settings, AUTH_RESET_URL: url }),
      ).assertReady(),
    ).toThrow('not configured');
  });

  it('sanitizes SMTP failures, consumes the failed reset and preserves the unknown-account response', async () => {
    jest.useFakeTimers();
    const transport = {
      sendMail: jest
        .fn()
        .mockRejectedValue(new Error('private provider detail')),
      close: jest.fn(),
    };
    jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue(
        transport as unknown as ReturnType<typeof nodemailer.createTransport>,
      );
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id })
          .mockResolvedValueOnce(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id, authVersion: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      passwordResetToken: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as AuthSessionsService,
      new SmtpPasswordResetMailer(new ConfigService(settings)),
    );
    const failedRequest = service.forgotPassword({
      email: 'account-owner@example.invalid',
    });
    await jest.advanceTimersByTimeAsync(3000);
    const failed = await failedRequest;
    const unknownRequest = service.forgotPassword({
      email: 'unknown@example.invalid',
    });
    await jest.advanceTimersByTimeAsync(3000);
    expect(await unknownRequest).toEqual(failed);
    expect(failed).toEqual({
      message:
        'If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable.',
    });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: id, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      data: { deliveryStatus: 'FAILED', consumedAt: expect.any(Date) },
    });
    expect(log.mock.calls).toEqual([
      ['Password recovery email delivery failed; check provider health'],
    ]);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
