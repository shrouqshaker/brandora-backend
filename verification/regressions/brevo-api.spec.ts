import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../src/auth/auth.service';
import { AuthSessionsService } from '../../src/auth/auth-sessions.service';
import { BrevoPasswordResetMailer } from '../../src/auth/password-reset.mailer';
import { resetOtp, resetOtpHash } from '../../src/auth/password-reset-otp';
import { PrismaService } from '../../src/prisma/prisma.service';

// Non-secret fixtures only. All HTTPS requests are mocked; no email is sent.
const settings = {
  AUTH_EMAIL_MODE: 'brevo',
  BREVO_API_KEY: 'dummy-api-key',
  BREVO_SENDER_EMAIL: 'no-reply@example.invalid',
};

describe('Brevo HTTPS password reset delivery (no network)', () => {
  let request: jest.SpyInstance<
    ReturnType<typeof fetch>,
    Parameters<typeof fetch>
  >;
  const mailer = (overrides = {}) =>
    new BrevoPasswordResetMailer(
      new ConfigService({ ...settings, ...overrides }),
    );

  beforeEach(() => {
    request = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ messageId: '<test-email-id@example.invalid>' }),
            { status: 201 },
          ),
      );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['brevo'])(
    'sends via HTTPS in %s mode with the verified sender and numeric OTP without any reset link',
    async (mode) => {
      const token = resetOtp();
      await mailer({ AUTH_EMAIL_MODE: mode }).send(
        'owner@example.invalid',
        token,
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        'https://api.brevo.com/v3/smtp/email',
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'api-key': settings.BREVO_API_KEY,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: expect.any(String),
          signal: expect.any(AbortSignal),
        },
      );
      const body = JSON.parse(request.mock.calls[0][1]!.body as string);
      expect(body).toMatchObject({
        sender: { email: settings.BREVO_SENDER_EMAIL },
        to: [{ email: 'owner@example.invalid' }],
        subject: 'Reset your Brandora password',
      });
      expect(body.textContent).toContain(`reset code is: ${token}`);
      expect(body.textContent).not.toContain('https://');
      expect(body.textContent).not.toContain('#token=');
      expect(body.textContent).not.toContain(settings.BREVO_API_KEY);
    },
  );

  it('trims private configuration and clears the HTTPS timer on acceptance', async () => {
    jest.useFakeTimers();
    await mailer({
      BREVO_API_KEY: ' dummy-api-key ',
      BREVO_SENDER_EMAIL: ' sender@example.invalid ',
    }).send('owner@example.invalid', resetOtp());
    const init = request.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)['api-key']).toBe(
      'dummy-api-key',
    );
    expect(JSON.parse(init.body as string).sender).toEqual({
      email: 'sender@example.invalid',
    });
    expect((init.signal as AbortSignal).aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { BREVO_API_KEY: '' },
    { BREVO_API_KEY: '   ' },
    { BREVO_API_KEY: 'key\r\ninjected' },
    { BREVO_API_KEY: 'key\u0000injected' },
    { BREVO_API_KEY: 'key with spaces' },
    { BREVO_SENDER_EMAIL: '' },
    { BREVO_SENDER_EMAIL: '  ' },
    { BREVO_SENDER_EMAIL: 'not-an-email' },
    { BREVO_SENDER_EMAIL: 'Brandora <sender@example.invalid>' },
    {
      BREVO_SENDER_EMAIL:
        'sender@example.invalid\r\nBcc: other@example.invalid',
    },
    { AUTH_EMAIL_MODE: 'disabled' },
    { AUTH_EMAIL_MODE: 'smtp' },
    { AUTH_EMAIL_MODE: 'resend' },
    { AUTH_EMAIL_MODE: 'unsupported' },
    { BREVO_API_KEY: '', RESEND_API_KEY: 'obsolete-test-key' },
    { BREVO_SENDER_EMAIL: '', SMTP_FROM: 'obsolete@example.invalid' },
  ])(
    'rejects invalid configuration before looking up any account or making an HTTPS request: %j',
    async (overrides) => {
      const lookup = jest.fn();
      const service = new AuthService(
        { user: { findUnique: lookup } } as unknown as PrismaService,
        {} as AuthSessionsService,
        mailer(overrides),
      );
      for (const email of [
        'owner@example.invalid',
        'unknown@example.invalid',
      ]) {
        await expect(service.forgotPassword({ email })).rejects.toMatchObject({
          code: 'AUTH_EMAIL_UNAVAILABLE',
        });
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([302, 400, 401, 403, 422, 429, 500, 503])(
    'sanitizes provider HTTP %i errors without reading or logging provider details',
    async (status) => {
      const json = jest.fn();
      request.mockResolvedValue({
        ok: false,
        status,
        json,
      } as unknown as Response);
      await expect(
        mailer().send('owner@example.invalid', resetOtp()),
      ).rejects.toThrow('Brevo email delivery failed');
      expect(json).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    '{}',
    '{"id":"legacy-acceptance"}',
    '{"messageId":""}',
    '{"messageId":"   "}',
    '{"messageId":42}',
    '{"messageId":null}',
    'null',
    '[]',
    '{"error":"private provider detail"}',
    'invalid json',
  ])('rejects malformed API acceptance: %s', async (body) => {
    request.mockResolvedValue(new Response(body));
    await expect(
      mailer().send('owner@example.invalid', resetOtp()),
    ).rejects.toThrow('Brevo email delivery failed');
  });

  it('sanitizes network errors', async () => {
    request.mockRejectedValue(new Error('private request details'));
    await expect(
      mailer().send('owner@example.invalid', resetOtp()),
    ).rejects.toThrow('Brevo email delivery failed');
  });

  it.each(['headers', 'body'])(
    'aborts a stalled HTTPS response during %s after 8 seconds',
    async (phase) => {
      jest.useFakeTimers();
      let signal!: AbortSignal;
      request.mockImplementation((_url, options) => {
        signal = options!.signal as AbortSignal;
        const stalled = () =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('private abort details')),
              { once: true },
            );
          });
        return phase === 'headers'
          ? stalled()
          : Promise.resolve({ ok: true, json: stalled } as unknown as Response);
      });
      const delivery = mailer().send('owner@example.invalid', resetOtp());
      const rejection = expect(delivery).rejects.toThrow(
        'Brevo email delivery failed',
      );
      await jest.advanceTimersByTimeAsync(7999);
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await rejection;
      expect(signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it.each(['success', 'provider error', 'timeout'])(
    'preserves synchronous delivery, hashed persistence, 15-minute expiry and enumeration protection on %s',
    async (outcome) => {
      jest.useFakeTimers();
      if (outcome === 'provider error') {
        request.mockRejectedValue(new Error('private provider detail'));
      } else if (outcome === 'timeout') {
        request.mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options!.signal!.addEventListener(
                'abort',
                () => reject(new Error('private timeout detail')),
                { once: true },
              );
            }),
        );
      }
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
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ id, authVersion: 0 }),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        passwordResetToken: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: jest.fn(),
      };
      prisma.$transaction.mockImplementation(async (work) => work(prisma));
      const service = new AuthService(
        prisma as unknown as PrismaService,
        {} as AuthSessionsService,
        mailer(),
      );
      const knownRequest = service.forgotPassword({
        email: 'owner@example.invalid',
      });
      const knownCompleted = jest.fn();
      void knownRequest.then(knownCompleted);
      await jest.advanceTimersByTimeAsync(8499);
      expect(knownCompleted).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      const known = await knownRequest;
      const unknownRequest = service.forgotPassword({
        email: 'unknown@example.invalid',
      });
      const unknownCompleted = jest.fn();
      void unknownRequest.then(unknownCompleted);
      await jest.advanceTimersByTimeAsync(8499);
      expect(unknownCompleted).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(await unknownRequest).toEqual(known);
      expect(known).toEqual({
        message:
          'If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable.',
      });
      const persisted =
        prisma.passwordResetToken.upsert.mock.calls[0][0].create;
      const payload = JSON.parse(request.mock.calls[0][1]!.body as string);
      const token = payload.textContent.match(/reset code is: ([0-9]{8})/)[1];
      expect(persisted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted.tokenHash).not.toEqual(token);
      expect(
        persisted.expiresAt.getTime() - persisted.createdAt.getTime(),
      ).toBe(15 * 60000);
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: id, tokenHash: persisted.tokenHash },
        data:
          outcome === 'success'
            ? { deliveryStatus: 'SENT' }
            : { deliveryStatus: 'FAILED', consumedAt: expect.any(Date) },
      });
      expect(log.mock.calls).toEqual(
        outcome === 'success'
          ? []
          : [
              [
                'Password recovery email delivery failed; check provider health',
              ],
            ],
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('a repeat forgot-password request sends a fresh token and supersedes the previous token without provider retries', async () => {
    jest.useFakeTimers();
    const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
    let record: any;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id, authVersion: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      passwordResetToken: {
        upsert: jest.fn(async ({ create }) => (record = { ...create })),
        updateMany: jest.fn(async ({ where, data }) => {
          if (where.tokenHash !== record.tokenHash) return { count: 0 };
          Object.assign(record, data);
          return { count: 1 };
        }),
        findUnique: jest.fn(async ({ where }) =>
          record && (!where.tokenHash || where.tokenHash === record.tokenHash)
            ? { ...record }
            : null,
        ),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as AuthSessionsService,
      mailer(),
    );
    for (let i = 0; i < 2; i++) {
      const response = service.forgotPassword({
        email: 'owner@example.invalid',
      });
      await jest.advanceTimersByTimeAsync(8500);
      await response;
    }
    const sentTokens = request.mock.calls.map(
      ([, init]) =>
        JSON.parse(init!.body as string).textContent.match(
          /reset code is: ([0-9]{8})/,
        )[1],
    );
    expect(sentTokens[0]).not.toBe(sentTokens[1]);
    expect(record).toMatchObject({
      tokenHash: resetOtpHash(
        'owner@example.invalid',
        sentTokens[1],
        process.env.AUTH_RATE_LIMIT_SECRET || process.env.JWT_SECRET!,
      ),
      deliveryStatus: 'SENT',
      consumedAt: null,
    });
    await expect(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: sentTokens[0],
        newPassword: 'NewSecurePassword123!',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_RESET_INVALID', status: 400 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
