import { Logger } from '@nestjs/common';
import argon2 from 'argon2';
import { AuthService } from '../../src/auth/auth.service';
import { AuthSessionsService } from '../../src/auth/auth-sessions.service';
import { PasswordResetMailer } from '../../src/auth/password-reset.mailer';
import { resetOtp, resetOtpHash } from '../../src/auth/password-reset-otp';
import * as resetCodes from '../../src/auth/password-reset-otp';
import { PrismaService } from '../../src/prisma/prisma.service';

const userId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
const password = 'NewSecurePassword123!';
const invalid = {
  code: 'AUTH_RESET_INVALID',
  message: 'Invalid or expired password reset token',
};

// In-memory persistence only. No database, provider request or real email.
function fixture(status = 'SENT') {
  const value = resetOtp();
  const token = {
    value,
    hash: resetOtpHash(
      'owner@example.invalid',
      value,
      process.env.AUTH_RATE_LIMIT_SECRET || process.env.JWT_SECRET!,
    ),
  };
  const user = {
    id: userId,
    authVersion: 3,
    passwordHash: 'old-password-hash',
  };
  const record = {
    userId,
    tokenHash: token.hash,
    authVersion: user.authVersion,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60000),
    consumedAt: null as Date | null,
    deliveryStatus: status,
  };
  const sessions = [
    { userId, revokedAt: null as Date | null },
    { userId, revokedAt: null as Date | null },
    { userId: 'another-user', revokedAt: null as Date | null },
  ];
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: userId }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockImplementation(async ({ data }) => {
        user.passwordHash = data.passwordHash;
        user.authVersion += data.authVersion.increment;
        return user;
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    passwordResetToken: {
      // Snapshot the initial read, so tests can change the locked reread independently.
      findUnique: jest
        .fn()
        .mockImplementation(async ({ where }) =>
          where.tokenHash && where.tokenHash !== record.tokenHash
            ? null
            : { ...record },
        ),
      upsert: jest
        .fn()
        .mockImplementation(async ({ create }) =>
          Object.assign(record, create),
        ),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) => Object.assign(record, data)),
      updateMany: jest.fn().mockImplementation(async ({ data }) => {
        Object.assign(record, data);
        return { count: 1 };
      }),
    },
    authSession: {
      updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
        const matching = sessions.filter(
          (session) =>
            session.userId === where.userId && session.revokedAt === null,
        );
        matching.forEach((session) => {
          session.revokedAt = data.revokedAt;
        });
        return { count: matching.length };
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (work) => work(prisma));
  const mailer = {
    assertReady: jest.fn(),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    {} as AuthSessionsService,
    mailer as PasswordResetMailer,
  );
  return { service, prisma, mailer, user, record, sessions, token };
}

async function expectInvalid(request: Promise<unknown>) {
  await expect(request).rejects.toMatchObject({
    code: invalid.code,
    response: invalid,
    status: 400,
  });
}

describe('Password reset requires confirmed delivery', () => {
  it('regenerates an RNG repeat on resend, rejects the previous code and redeems the newly sent code once', async () => {
    jest.useFakeTimers();
    const { service, prisma, mailer, token, record } = fixture();
    const next = (token.value[0] === '9' ? '0' : '9') + token.value.slice(1);
    const rng = jest
      .spyOn(resetCodes, 'resetOtp')
      .mockReturnValueOnce(token.value)
      .mockReturnValueOnce(next);
    const response = service.forgotPassword({ email: 'owner@example.invalid' });
    await jest.advanceTimersByTimeAsync(8500);
    await response;
    expect(rng).toHaveBeenCalledTimes(2);
    expect(mailer.send).toHaveBeenCalledWith('owner@example.invalid', next);
    expect(record.deliveryStatus).toBe('SENT');
    expect(record.tokenHash).not.toBe(next);
    jest.useRealTimers();
    await expectInvalid(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: token.value,
        newPassword: password,
      }),
    );
    await expect(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: next,
        newPassword: password,
      }),
    ).resolves.toBeUndefined();
    await expectInvalid(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: next,
        newPassword: password,
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.authSession.updateMany).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong code', 'wrong account', 'legacy token'])(
    'rejects %s with the generic error without password/session writes',
    async (condition) => {
      const { service, token, prisma } = fixture();
      await expectInvalid(
        service.resetPassword({
          email:
            condition === 'wrong account'
              ? 'another@example.invalid'
              : 'owner@example.invalid',
          otp:
            condition === 'legacy token'
              ? 'legacy-link-token'
              : condition === 'wrong code'
                ? (token.value[0] === '9' ? '0' : '9') + token.value.slice(1)
                : token.value,
          newPassword: password,
        }),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    },
  );
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['PENDING', 'FAILED', 'UNKNOWN', ''])(
    'rejects initial %s status with the existing generic error before hashing or writes',
    async (status) => {
      const { service, prisma, token } = fixture(status);
      const hash = jest.spyOn(argon2, 'hash');
      await expectInvalid(
        service.resetPassword({
          email: 'owner@example.invalid',
          otp: token.value,
          newPassword: password,
        }),
      );
      expect(hash).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it('accepts SENT once, hashes the new password, increments auth-version and revokes only that user sessions', async () => {
    const { service, prisma, token, user, record, sessions } = fixture();
    await expect(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: token.value,
        newPassword: password,
      }),
    ).resolves.toBeUndefined();
    expect(await argon2.verify(user.passwordHash, password)).toBe(true);
    expect(user.passwordHash).not.toBe(password);
    expect(user.authVersion).toBe(4);
    expect(record.consumedAt).toBeInstanceOf(Date);
    expect(
      sessions
        .slice(0, 2)
        .every((session) => session.revokedAt instanceof Date),
    ).toBe(true);
    expect(sessions[2].revokedAt).toBeNull();
    await expectInvalid(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: token.value,
        newPassword: password,
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.authSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(['PENDING', 'FAILED'])(
    'rechecks %s delivery status under the user lock after an initial SENT read',
    async (status) => {
      const { service, prisma, token, record } = fixture();
      prisma.$transaction.mockImplementation(async (work) => {
        record.deliveryStatus = status;
        return work(prisma);
      });
      await expectInvalid(
        service.resetPassword({
          email: 'owner@example.invalid',
          otp: token.value,
          newPassword: password,
        }),
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.passwordResetToken.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it('rejects an expired SENT token before changing any password', async () => {
    const { service, prisma, token, record } = fixture();
    record.expiresAt = new Date(Date.now() - 1000);
    await expectInvalid(
      service.resetPassword({
        email: 'owner@example.invalid',
        otp: token.value,
        newPassword: password,
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['expired', 'consumed', 'auth-version', 'superseded'])(
    'rejects a token invalidated by %s between initial read and locked reread',
    async (condition) => {
      const { service, prisma, token, record, user } = fixture();
      prisma.$transaction.mockImplementation(async (work) => {
        if (condition === 'expired')
          record.expiresAt = new Date(Date.now() - 1000);
        if (condition === 'consumed') record.consumedAt = new Date();
        if (condition === 'auth-version') user.authVersion++;
        if (condition === 'superseded') record.tokenHash = '0'.repeat(64);
        return work(prisma);
      });
      await expectInvalid(
        service.resetPassword({
          email: 'owner@example.invalid',
          otp: token.value,
          newPassword: password,
        }),
      );
      expect(prisma.passwordResetToken.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['provider timeout', 'SENT persistence failure'])(
    'keeps a PENDING token unusable if invalidation also fails after %s',
    async (failure) => {
      jest.useFakeTimers();
      const { service, prisma, mailer, record } = fixture();
      let emailedToken = '';
      mailer.send.mockImplementation(async (_email: string, token: string) => {
        emailedToken = token;
        if (failure === 'provider timeout')
          throw new Error('private provider detail');
      });
      prisma.passwordResetToken.updateMany.mockRejectedValue(
        new Error('private database arguments'),
      );
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const known = service.forgotPassword({ email: 'owner@example.invalid' });
      await jest.advanceTimersByTimeAsync(8500);
      const response = await known;
      expect(record.deliveryStatus).toBe('PENDING');
      expect(record.consumedAt).toBeNull();
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId, tokenHash: record.tokenHash },
        data: { deliveryStatus: 'FAILED', consumedAt: expect.any(Date) },
      });
      prisma.user.findUnique.mockResolvedValueOnce(null);
      const unknown = service.forgotPassword({
        email: 'unknown@example.invalid',
      });
      await jest.advanceTimersByTimeAsync(8500);
      expect(await unknown).toEqual(response);
      expect(response.message).toBe(
        'If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable.',
      );
      await expectInvalid(
        service.resetPassword({
          email: 'owner@example.invalid',
          otp: emailedToken,
          newPassword: password,
        }),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([
        ['Password recovery email delivery failed; check provider health'],
        [
          'Password recovery processing failed; check database and email health',
        ],
      ]);
    },
  );
});
