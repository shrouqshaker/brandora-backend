import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, User } from '../generated/prisma/client';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { equalHash, opaqueToken, tokenHash, tokenLocator } from './auth-tokens';

export async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  return tx.user.findUniqueOrThrow({ where: { id: userId } });
}
type SessionUser = Pick<User, 'id' | 'email' | 'authVersion'>;
@Injectable()
export class AuthSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async issue(tx: Prisma.TransactionClient, user: SessionUser) {
    // Caller holds the User row lock. Reuse at most ten device slots; never grow
    // a per-refresh token table or retain an unlimited number of old sessions.
    const slots = await tx.authSession.findMany({
      where: { userId: user.id },
      orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const now = new Date();
    const reusable =
      slots.find((slot) => slot.revokedAt || slot.expiresAt <= now) ??
      (slots.length >= 10 ? slots[0] : undefined);
    const token = opaqueToken();
    const data = {
      userId: user.id,
      tokenFamilyId: token.locator,
      refreshTokenHash: token.hash,
      usedTokenHashes: [],
      rotationCount: 0,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86400000),
      revokedAt: null,
    };
    const session = reusable
      ? await tx.authSession.update({ where: { id: reusable.id }, data })
      : await tx.authSession.create({ data });
    return this.response(
      user,
      token.value,
      session.tokenFamilyId,
      session.expiresAt,
    );
  }
  private async response(
    user: SessionUser,
    refreshToken: string,
    family: string,
    expires: Date,
  ) {
    return {
      user: { id: user.id, email: user.email },
      accessToken: await this.jwt.signAsync({
        sub: user.id,
        sid: family,
        ver: user.authVersion,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: expires.toISOString(),
    };
  }
  async refresh(value: string) {
    const family = tokenLocator(value);
    if (!family) return this.invalid();
    const initial = await this.prisma.authSession.findUnique({
      where: { tokenFamilyId: family },
      select: { userId: true },
    });
    if (!initial) return this.invalid();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const user = await lockUser(tx, initial.userId);
        const session = await tx.authSession.findUnique({
          where: { tokenFamilyId: family },
        });
        const now = new Date();
        if (!session || session.revokedAt || session.expiresAt <= now)
          return null;
        const digest = tokenHash(value);
        if (!equalHash(session.refreshTokenHash, digest)) {
          if (session.usedTokenHashes.includes(digest))
            await tx.authSession.update({
              where: { id: session.id },
              data: { revokedAt: now },
            });
          // Return before throwing, so replay revocation commits instead of rolling back.
          return null;
        }
        if (session.rotationCount >= 1000) {
          await tx.authSession.update({
            where: { id: session.id },
            data: { revokedAt: now },
          });
          return null;
        }
        const replacement = opaqueToken(family);
        await tx.authSession.update({
          where: { id: session.id },
          data: {
            refreshTokenHash: replacement.hash,
            usedTokenHashes: { push: digest },
            rotationCount: { increment: 1 },
            lastUsedAt: now,
          },
        });
        return this.response(
          user,
          replacement.value,
          family,
          session.expiresAt,
        );
      },
      { maxWait: 5000, timeout: 10000 },
    );
    if (!result) return this.invalid();
    return result;
  }
  async logout(value: string) {
    const family = tokenLocator(value);
    if (!family) return;
    const initial = await this.prisma.authSession.findUnique({
      where: { tokenFamilyId: family },
      select: { userId: true },
    });
    if (!initial) return;
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, initial.userId);
      const session = await tx.authSession.findUnique({
        where: { tokenFamilyId: family },
      });
      const hash = tokenHash(value);
      if (
        session &&
        (equalHash(session.refreshTokenHash, hash) ||
          session.usedTokenHashes.includes(hash))
      )
        await tx.authSession.update({
          where: { id: session.id },
          data: { revokedAt: session.revokedAt ?? new Date() },
        });
    });
  }
  async logoutAll(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: { authVersion: { increment: 1 } },
      });
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
  private invalid(): never {
    throw new AppHttpException(
      ErrorCode.AUTH_REFRESH_INVALID,
      HttpStatus.UNAUTHORIZED,
      'Invalid or expired refresh session; log in again',
    );
  }
}
