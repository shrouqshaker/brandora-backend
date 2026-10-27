import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { AUTH_SCOPE, AuthRequest, Scope } from './auth-policy';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const scope = this.reflector.getAllAndOverride<Scope>(AUTH_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (scope === 'public') return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    if (
      typeof header !== 'string' ||
      header.length > 4096 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)
    )
      this.unauthorized();
    let userId: string;
    let sessionId: string;
    let version: number;
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(
        header.slice(7),
      );
      if (
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        typeof payload.sid !== 'string' ||
        !isUUID(payload.sid, '4') ||
        typeof payload.ver !== 'number' ||
        !Number.isSafeInteger(payload.ver) ||
        payload.ver < 0
      )
        this.unauthorized();
      userId = payload.sub;
      sessionId = payload.sid;
      version = payload.ver;
    } catch {
      this.unauthorized();
    }
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, authVersion: true },
    });
    if (!currentUser || currentUser.authVersion !== version)
      this.unauthorized();
    const session = await this.prisma.authSession.findUnique({
      where: { tokenFamilyId: sessionId },
      select: { userId: true, expiresAt: true, revokedAt: true },
    });
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    )
      this.unauthorized();
    request.user = { id: userId, sessionId };
    if (scope === 'identity') return true;
    if (!scope)
      throw new AppHttpException(
        ErrorCode.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'No access policy for this operation',
      );
    let businessId: unknown;
    if (scope === 'import') {
      const id = request.params.importId;
      if (typeof id !== 'string' || !isUUID(id)) this.hidden();
      businessId = (
        await this.prisma.importJob.findUnique({
          where: { id },
          select: { businessId: true },
        })
      )?.businessId;
    } else businessId = request[scope]?.businessId;
    if (typeof businessId !== 'string' || !isUUID(businessId)) this.hidden();
    const member = await this.prisma.businessMember.findUnique({
      where: { userId_businessId: { userId, businessId } },
      select: { role: true, isActive: true },
    });
    if (!member?.isActive || member.role !== 'OWNER') this.hidden();
    return true;
  }
  private unauthorized(): never {
    throw new AppHttpException(
      ErrorCode.UNAUTHORIZED,
      HttpStatus.UNAUTHORIZED,
      'Invalid or missing access token',
    );
  }
  private hidden(): never {
    throw new AppHttpException(
      ErrorCode.NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Resource not found',
    );
  }
}
