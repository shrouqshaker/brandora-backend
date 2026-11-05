import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { Workbook } from 'exceljs';
import argon2 from 'argon2';
import { AuthService } from '../../src/auth/auth.service';
import { AuthSessionsService } from '../../src/auth/auth-sessions.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PasswordResetMailer } from '../../src/auth/password-reset.mailer';
import { AuthRateGuard } from '../../src/auth/auth-rate.guard';
import { AuthRateStore, RateRule } from '../../src/auth/auth-rate.store';
import { RefreshTokenDto, ResetPasswordDto } from '../../src/auth/auth.dto';
import {
  equalHash,
  opaqueToken,
  tokenHash,
  tokenLocator,
} from '../../src/auth/auth-tokens';
import { BrevoPasswordResetMailer } from '../../src/auth/password-reset.mailer';

class SharedFakeStore extends AuthRateStore {
  readonly counters = new Map<string, number>();
  readonly seen: RateRule[][] = [];
  async consume(rules: RateRule[]) {
    this.seen.push(rules);
    let allowed = true;
    for (const rule of rules) {
      const count = (this.counters.get(rule.key) ?? 0) + 1;
      this.counters.set(rule.key, count);
      if (count > rule.limit) allowed = false;
    }
    return { allowed, retryAfter: allowed ? 0 : 60 };
  }
}
describe('Shared authentication limits and proxy boundaries', () => {
  let store: SharedFakeStore;
  const key = randomBytes(48).toString('base64');
  const makeGuard = (cidrs = '') =>
    new AuthRateGuard(
      store,
      new ConfigService({ JWT_SECRET: key, AUTH_TRUSTED_PROXY_CIDRS: cidrs }),
    );
  const setHeader = jest.fn();
  function context(
    forwarded?: string,
    peer = '127.0.0.1',
    action = 'register',
    body: object = {},
  ) {
    const handler = { [action]: () => {} }[action];
    return {
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-forwarded-for': forwarded },
          socket: { remoteAddress: peer },
          body,
        }),
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
  }
  beforeEach(() => {
    store = new SharedFakeStore();
    setHeader.mockReset();
  });
  it('shares a limit across two independent guard instances and concurrent calls', async () => {
    const guards = [makeGuard(), makeGuard()];
    const result = await Promise.allSettled(
      Array.from({ length: 14 }, (_v, i) =>
        guards[i % 2].canActivate(context()),
      ),
    );
    expect(result.filter((v) => v.status === 'fulfilled')).toHaveLength(10);
    expect(result.filter((v) => v.status === 'rejected')).toHaveLength(4);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });
  it('ignores spoofed forwarded headers from untrusted peers', async () => {
    const guard = makeGuard();
    await guard.canActivate(context('198.51.100.1'));
    await guard.canActivate(context('203.0.113.2'));
    expect(store.seen[0]).toEqual(store.seen[1]);
  });
  it('trusts only the explicit proxy chain and stops at the first untrusted hop', async () => {
    const guard = makeGuard('127.0.0.1/32');
    await guard.canActivate(context('1.2.3.4, 198.51.100.1'));
    await guard.canActivate(context('9.8.7.6, 198.51.100.1'));
    expect(store.seen[0]).toEqual(store.seen[1]);
  });
  it('canonicalizes IPv4-mapped IPv6 client addresses', async () => {
    const guard = makeGuard();
    await guard.canActivate(context(undefined, '::ffff:127.0.0.1'));
    await guard.canActivate(context(undefined, '127.0.0.1'));
    expect(store.seen[0]).toEqual(store.seen[1]);
  });
  it('does not trust arbitrary IPv4 peers through an incorrectly short IPv4-mapped IPv6 subnet', async () => {
    const guard = makeGuard('::ffff:10.0.0.0/8');
    await guard.canActivate(context('1.2.3.4', '198.51.100.7'));
    await guard.canActivate(context('9.8.7.6', '198.51.100.7'));
    expect(store.seen[0]).toEqual(store.seen[1]);
  });
  it('rejects oversized trusted forwarding headers', async () => {
    await expect(
      makeGuard('127.0.0.1/32').canActivate(context('x'.repeat(1025))),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(store.seen).toHaveLength(0);
  });
  it('fails closed only at the sensitive guard when its backend is unavailable', async () => {
    const guard = makeGuard();
    jest
      .spyOn(store, 'consume')
      .mockRejectedValue(new Error('private connection details'));
    await expect(guard.canActivate(context())).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMIT_UNAVAILABLE',
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });
  it.each([
    'register',
    'login',
    'refresh',
    'forgotPassword',
    'resetPassword',
    'logout',
  ])('has a policy for %s', async (action) => {
    expect(
      await makeGuard().canActivate(context(undefined, '127.0.0.1', action)),
    ).toBe(true);
  });
  it('stores only purpose-separated HMAC keys, including normalized email keys', async () => {
    const guard = makeGuard();
    await guard.canActivate(
      context(undefined, '127.0.0.1', 'login', {
        email: ' Owner@Example.com ',
      }),
    );
    await guard.canActivate(
      context(undefined, '127.0.0.1', 'login', { email: 'owner@example.com' }),
    );
    expect(store.seen[0]).toEqual(store.seen[1]);
    expect(store.seen[0]).toHaveLength(2);
    for (const rule of store.seen[0])
      expect(rule.key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(store.seen)).not.toContain('owner@example.com');
  });
  it('limits OTP guesses across IPs and instances by normalized email, not the guessed code', async () => {
    const guards = [makeGuard(), makeGuard()];
    for (let i = 0; i < 5; i++) {
      await guards[i % 2].canActivate(
        context(undefined, `192.0.2.${i + 1}`, 'resetPassword', {
          email: i % 2 ? ' Owner@Example.com ' : 'owner@example.com',
          otp: String(i).padStart(8, '0'),
        }),
      );
    }
    await expect(
      guards[1].canActivate(
        context(undefined, '192.0.2.99', 'resetPassword', {
          email: 'owner@example.com',
          otp: '99999999',
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(new Set(store.seen.map((rules) => rules[1].key)).size).toBe(1);
    expect(store.seen[0][1]).toMatchObject({ limit: 5, seconds: 900 });
    // Resending uses an independent quota and cannot replenish guess attempts.
    await guards[0].canActivate(
      context(undefined, '192.0.2.99', 'forgotPassword', {
        email: 'owner@example.com',
      }),
    );
    await expect(
      guards[0].canActivate(
        context(undefined, '192.0.2.100', 'resetPassword', {
          email: 'owner@example.com',
          otp: '00000000',
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });
  });
  it('rejects invalid configured proxy CIDRs at startup', () => {
    expect(() => makeGuard('not-a-network')).toThrow();
  });
  it('cannot exhaust a real token quota merely by knowing its public family locator', async () => {
    const a = opaqueToken(),
      b = opaqueToken(a.locator);
    const guard = makeGuard();
    await guard.canActivate(
      context(undefined, '127.0.0.1', 'refresh', { refreshToken: a.value }),
    );
    await guard.canActivate(
      context(undefined, '127.0.0.1', 'refresh', { refreshToken: b.value }),
    );
    expect(store.seen[0][0].key).toBe(store.seen[1][0].key);
    expect(store.seen[0][1].key).not.toBe(store.seen[1][1].key);
  });
});

describe('Opaque tokens, reset validation and Brevo readiness', () => {
  it('bounds expensive registration hashing to two workers and releases capacity', async () => {
    const releases: ((value: string) => void)[] = [];
    const hash = jest
      .spyOn(argon2, 'hash')
      .mockImplementation(
        () => new Promise<string>((resolve) => releases.push(resolve)),
      );
    const tx = {
      user: {
        create: jest.fn().mockResolvedValue({
          id: 'test-user',
          email: 'owner@example.com',
          authVersion: 0,
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
    const sessions = {
      issue: jest.fn().mockResolvedValue({
        user: { id: 'test-user', email: 'owner@example.com' },
      }),
    };
    const auth = new AuthService(
      prisma as unknown as PrismaService,
      sessions as unknown as AuthSessionsService,
      {} as PasswordResetMailer,
    );
    try {
      const body = {
        email: 'owner@example.com',
        password: 'SecurePassword123!',
      };
      const first = auth.register(body),
        second = auth.register(body);
      await expect(auth.register(body)).rejects.toMatchObject({
        code: 'AUTH_RATE_LIMITED',
      });
      expect(hash).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      for (const release of releases) release('$argon2id$controlled-test-hash');
      await Promise.all([first, second]);
      hash.mockResolvedValue('$argon2id$controlled-test-hash');
      await expect(auth.register(body)).resolves.toHaveProperty(
        'user.id',
        'test-user',
      );
    } finally {
      hash.mockRestore();
    }
  });
  it('generates independent 256-bit opaque secrets and SHA-256 storage hashes', () => {
    const a = opaqueToken(),
      b = opaqueToken();
    expect(a.value).toHaveLength(80);
    expect(a.value).not.toBe(b.value);
    expect(tokenLocator(a.value)).toBe(a.locator);
    expect(a.hash).toBe(tokenHash(a.value));
    expect(a.hash).not.toContain(a.value);
    expect(equalHash(a.hash, a.hash)).toBe(true);
    expect(equalHash(a.hash, b.hash)).toBe(false);
    expect(equalHash('z'.repeat(64), a.hash)).toBe(false);
  });
  it.each(['', 'x', 'a'.repeat(10000), 'not-a-uuid.' + 'A'.repeat(43)])(
    'rejects malformed token %#',
    (value) => {
      expect(tokenLocator(value)).toBeNull();
      expect(
        validateSync(plainToInstance(RefreshTokenDto, { refreshToken: value }))
          .length,
      ).toBeGreaterThan(0);
    },
  );
  it.each(['weak', 'Aa1' + 'x'.repeat(126), 'Aa1' + '\u{1F600}'.repeat(63)])(
    'applies the registration policy to reset passwords %#',
    (newPassword) => {
      expect(
        validateSync(
          plainToInstance(ResetPasswordDto, {
            email: 'owner@example.invalid',
            otp: '12345678',
            newPassword,
          }),
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it('accepts bounded strong reset passwords and rejects privileged extra properties', () => {
    const data = {
      email: 'owner@example.invalid',
      otp: '12345678',
      newPassword: 'NewSecurePassword123!',
    };
    expect(validateSync(plainToInstance(ResetPasswordDto, data))).toEqual([]);
    expect(
      validateSync(
        plainToInstance(ResetPasswordDto, { ...data, userId: 'other' }),
        { whitelist: true, forbidNonWhitelisted: true },
      ).length,
    ).toBeGreaterThan(0);
  });
  it('does not pretend an unconfigured email provider is ready', () => {
    expect(() =>
      new BrevoPasswordResetMailer(
        new ConfigService({ AUTH_EMAIL_MODE: 'disabled' }),
      ).assertReady(),
    ).toThrow('not configured');
  });
  it('rejects a missing Brevo API key', () => {
    expect(() =>
      new BrevoPasswordResetMailer(
        new ConfigService({
          AUTH_EMAIL_MODE: 'brevo',
          BREVO_API_KEY: '',
          BREVO_SENDER_EMAIL: 'no-reply@example.com',
        }),
      ).assertReady(),
    ).toThrow('not configured');
  });
  it('validates Brevo API key configuration before looking up any account', () => {
    const config = new ConfigService({
      AUTH_EMAIL_MODE: 'brevo',
      AUTH_RESET_URL: 'https://example.com/reset',
      BREVO_API_KEY: '',
      BREVO_SENDER_EMAIL: 'no-reply@example.com',
    });
    expect(() => new BrevoPasswordResetMailer(config).assertReady()).toThrow(
      'not configured',
    );
  });
  it('uses the Brevo HTTPS API with an OTP and no reset link', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ messageId: '<test-email-id@example.invalid>' }),
        ),
      );
    try {
      const token = '12345678';
      await new BrevoPasswordResetMailer(
        new ConfigService({
          AUTH_EMAIL_MODE: 'brevo',
          AUTH_RESET_URL: 'https://example.com/reset',
          BREVO_API_KEY: 'test-key',
          BREVO_SENDER_EMAIL: 'no-reply@example.com',
        }),
      ).send('owner@example.com', token);
      expect(spy).toHaveBeenCalledWith(
        'https://api.brevo.com/v3/smtp/email',
        expect.objectContaining({
          method: 'POST',
          signal: expect.any(AbortSignal),
        }),
      );
      const request = spy.mock.calls[0][1]!;
      const message = JSON.parse(request.body as string) as {
        textContent: string;
      };
      expect(message.textContent).toContain(`reset code is: ${token}`);
      expect(message.textContent).not.toContain('?token=');
    } finally {
      spy.mockRestore();
    }
  });
  it('does not expose Brevo response details when delivery fails', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);
    try {
      await expect(
        new BrevoPasswordResetMailer(
          new ConfigService({
            AUTH_EMAIL_MODE: 'brevo',
            AUTH_RESET_URL: 'https://example.com/reset',
            BREVO_API_KEY: 'test-key',
            BREVO_SENDER_EMAIL: 'no-reply@example.com',
          }),
        ).send('owner@example.com', '12345678'),
      ).rejects.toThrow('Brevo email delivery failed');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('round-trips Excel conditional formatting through the patched UUID CommonJS v4 dependency', async () => {
    const book = new Workbook();
    const sheet = book.addWorksheet('Security regression');
    sheet.addRows([[1], [2], [3]]);
    sheet.addConditionalFormatting({
      ref: 'A1:A3',
      rules: [
        {
          type: 'iconSet',
          iconSet: '3Stars',
          priority: 1,
          cfvo: [
            { type: 'percent', value: 0 },
            { type: 'percent', value: 33 },
            { type: 'percent', value: 67 },
          ],
        },
      ],
    });
    const bytes = await book.xlsx.writeBuffer();
    const reloaded = new Workbook();
    await reloaded.xlsx.load(bytes);
    expect(reloaded.worksheets[0].getCell('A2').value).toBe(2);
    const formatting = (
      reloaded.worksheets[0] as unknown as { conditionalFormattings: unknown[] }
    ).conditionalFormattings;
    expect(formatting.length).toBeGreaterThan(0);
  });
});
