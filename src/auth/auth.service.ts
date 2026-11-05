import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import {
  LoginDto,
  RegisterDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './auth.dto';
import { AuthSessionsService, lockUser } from './auth-sessions.service';
import { PasswordResetMailer } from './password-reset.mailer';
import { equalHash } from './auth-tokens';
import { resetOtp, resetOtpHash } from './password-reset-otp';

const hashing = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;
@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  private passwordWorkers = 0;
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionsService,
    private readonly mailer: PasswordResetMailer,
    private readonly config: ConfigService = new ConfigService(),
  ) {}
  async onModuleInit() {
    this.dummyHash = await argon2.hash(randomBytes(32), hashing);
  }
  async register(dto: RegisterDto) {
    const passwordHash = await this.passwordWork(() =>
      argon2.hash(dto.password, hashing),
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: dto.email, passwordHash },
          select: { id: true, email: true, authVersion: true },
        });
        return this.sessions.issue(tx, user);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppHttpException(
          ErrorCode.EMAIL_UNAVAILABLE,
          HttpStatus.CONFLICT,
          'Email is unavailable',
        );
      // Do not propagate an ORM exception potentially containing credentials.
      throw new AppHttpException(
        ErrorCode.INTERNAL_SERVER_ERROR,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Registration could not be completed',
      );
    }
  }
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const matches = await this.passwordWork(() =>
      argon2.verify(user?.passwordHash ?? this.dummyHash, dto.password),
    );
    if (!user || !matches)
      throw new AppHttpException(
        ErrorCode.INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
        'Invalid email or password',
      );
    return this.prisma.$transaction(async (tx) => {
      const current = await lockUser(tx, user.id);
      if (
        current.authVersion !== user.authVersion ||
        current.passwordHash !== user.passwordHash
      )
        throw new AppHttpException(
          ErrorCode.INVALID_CREDENTIALS,
          HttpStatus.UNAUTHORIZED,
          'Invalid email or password',
        );
      return this.sessions.issue(tx, current);
    });
  }
  async forgotPassword(dto: ForgotPasswordDto) {
    // Configuration errors use the same 503 for known and unknown accounts.
    this.mailer.assertReady();
    const secret = this.resetSecret();
    const started = Date.now();
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      let otp = resetOtp();
      let digest = resetOtpHash(dto.email, otp, secret);
      if (user) {
        await this.prisma.$transaction(async (tx) => {
          const current = await lockUser(tx, user.id);
          const previous = await tx.passwordResetToken.findUnique({
            where: { userId: user.id },
          });
          // A resend must invalidate the previous code, even on an RNG repeat.
          while (previous?.tokenHash === digest) {
            otp = resetOtp();
            digest = resetOtpHash(dto.email, otp, secret);
          }
          const now = new Date();
          const data = {
            tokenHash: digest,
            authVersion: current.authVersion,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 15 * 60000),
            consumedAt: null,
            deliveryStatus: 'PENDING',
          };
          await tx.passwordResetToken.upsert({
            where: { userId: user.id },
            create: { userId: user.id, ...data },
            update: data,
          });
        });
        try {
          await this.mailer.send(dto.email, otp);
          await this.prisma.passwordResetToken.updateMany({
            where: { userId: user.id, tokenHash: digest },
            data: { deliveryStatus: 'SENT' },
          });
        } catch {
          this.logger.error(
            'Password recovery email delivery failed; check provider health',
          );
          await this.prisma.passwordResetToken.updateMany({
            where: { userId: user.id, tokenHash: digest },
            data: { deliveryStatus: 'FAILED', consumedAt: new Date() },
          });
        }
      }
    } catch {
      this.logger.error(
        'Password recovery processing failed; check database and email health',
      );
    } finally {
      // Email delivery has an 8s deadline. Flatten the normal known/unknown path.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 8500 - (Date.now() - started))),
      );
    }
    return {
      message:
        'If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable.',
    };
  }
  async resetPassword(dto: ResetPasswordDto) {
    const invalid = () =>
      new AppHttpException(
        ErrorCode.AUTH_RESET_INVALID,
        HttpStatus.BAD_REQUEST,
        'Invalid or expired password reset token',
      );
    if (
      typeof dto.otp !== 'string' ||
      dto.otp.length !== 8 ||
      !/^[0-9]{8}$/.test(dto.otp)
    )
      throw invalid();
    const digest = resetOtpHash(dto.email, dto.otp, this.resetSecret());
    const initial = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: digest },
    });
    if (
      !initial ||
      initial.deliveryStatus !== 'SENT' ||
      initial.consumedAt ||
      initial.expiresAt <= new Date()
    )
      throw invalid();
    const passwordHash = await this.passwordWork(() =>
      argon2.hash(dto.newPassword, hashing),
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await lockUser(tx, initial.userId);
        const token = await tx.passwordResetToken.findUnique({
          where: { userId: user.id },
        });
        if (
          !token ||
          !equalHash(token.tokenHash, digest) ||
          token.consumedAt ||
          token.expiresAt <= new Date() ||
          token.authVersion !== user.authVersion ||
          token.deliveryStatus !== 'SENT'
        )
          throw invalid();
        await tx.passwordResetToken.update({
          where: { userId: user.id },
          data: { consumedAt: new Date() },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, authVersion: { increment: 1 } },
        });
        await tx.authSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
    } catch (error) {
      if (error instanceof AppHttpException) throw error;
      // Never log ORM errors whose arguments may include a new password hash.
      throw new AppHttpException(
        ErrorCode.INTERNAL_SERVER_ERROR,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Password reset could not be completed',
      );
    }
  }
  private resetSecret() {
    const secret =
      this.config.get<string>('AUTH_RATE_LIMIT_SECRET') ||
      this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret) < 32)
      throw new AppHttpException(
        ErrorCode.AUTH_EMAIL_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Password recovery email is not configured',
      );
    return secret;
  }
  private async passwordWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.passwordWorkers >= 2)
      throw new AppHttpException(
        ErrorCode.AUTH_RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
        'Authentication is busy; retry shortly',
      );
    this.passwordWorkers++;
    try {
      return await work();
    } finally {
      this.passwordWorkers--;
    }
  }
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        memberships: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            business: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!user)
      throw new AppHttpException(
        ErrorCode.UNAUTHORIZED,
        HttpStatus.UNAUTHORIZED,
        'Invalid access token',
      );
    return {
      id: user.id,
      email: user.email,
      businesses: user.memberships.map((m) => ({
        ...m.business,
        role: m.role,
      })),
    };
  }
}
