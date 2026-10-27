import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../../src/auth/auth.guard';
import { AUTH_SCOPE, AuthRequest, Scope } from '../../src/auth/auth-policy';
import { AuthRateGuard } from '../../src/auth/auth-rate.guard';
import { jwtConfig } from '../../src/auth/auth-config';
import { LoginDto, RegisterDto } from '../../src/auth/auth.dto';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Authentication and current database ownership', () => {
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const config = jwtConfig(
    new ConfigService({
      JWT_SECRET: randomBytes(48).toString('base64'),
      JWT_ISSUER: 'test',
      JWT_AUDIENCE: 'android',
    }),
  );
  const jwt = new JwtService(config);
  let request: AuthRequest;
  let scope: Scope | undefined;
  const prisma = {
    user: { findUnique: jest.fn() },
    authSession: { findUnique: jest.fn() },
    businessMember: { findUnique: jest.fn() },
    importJob: { findUnique: jest.fn() },
  };
  const reflector = { getAllAndOverride: () => scope };
  const guard = new AuthGuard(
    reflector as unknown as Reflector,
    jwt,
    prisma as unknown as PrismaService,
  );
  const context = {
    getHandler: () => function endpoint() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  beforeEach(async () => {
    jest.resetAllMocks();
    scope = 'params';
    request = {
      headers: {
        authorization: `Bearer ${await jwt.signAsync({ sub: id, sid: id, ver: 0 })}`,
      },
      params: { businessId: id },
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    prisma.user.findUnique.mockResolvedValue({ id, authVersion: 0 });
    prisma.authSession.findUnique.mockResolvedValue({
      userId: id,
      expiresAt: new Date('2099-01-01'),
      revokedAt: null,
    });
    prisma.businessMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      isActive: true,
    });
  });
  it('allows the explicit public scope without consulting identity', async () => {
    scope = 'public';
    request.headers = {};
    expect(await guard.canActivate(context)).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    '',
    'Bearer',
    'Basic abc',
    'Bearer a.b.c extra',
    'Bearer  a.b.c',
    ['Bearer a.b.c'],
  ])('rejects malformed header %#', async (header) => {
    request.headers.authorization = header as string;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it.each([
    { expiresIn: -1 },
    { issuer: 'wrong' },
    { audience: 'wrong' },
    { algorithm: 'HS384' as const },
    { secret: 'wrong-secret' },
  ])('rejects invalid token policy %#', async (options) => {
    request.headers.authorization = `Bearer ${await jwt.signAsync({ sub: id, sid: id, ver: 0 }, options)}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('rejects deleted users', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('rejects legacy access tokens without a server-side session', async () => {
    request.headers.authorization = `Bearer ${await jwt.signAsync({ sub: id })}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('rejects a token after the database auth version changes', async () => {
    prisma.user.findUnique.mockResolvedValue({ id, authVersion: 1 });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it.each([
    null,
    { userId: 'other', expiresAt: new Date('2099-01-01'), revokedAt: null },
    { userId: id, expiresAt: new Date('2000-01-01'), revokedAt: null },
    { userId: id, expiresAt: new Date('2099-01-01'), revokedAt: new Date() },
  ])(
    'rejects missing, mismatched, expired or revoked sessions %#',
    async (session) => {
      prisma.authSession.findUnique.mockResolvedValue(session);
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    },
  );
  it('denies a new route without an explicit scope', async () => {
    scope = undefined;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it.each([
    null,
    { role: 'OWNER', isActive: false },
    { role: 'STAFF', isActive: true },
  ])('hides missing/inactive/unauthorized membership %#', async (member) => {
    prisma.businessMember.findUnique.mockResolvedValue(member);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it.each(['params', 'body', 'query'] as const)(
    'uses the same %s business scope as the controller',
    async (source) => {
      scope = source;
      request[source] = { businessId: id };
      expect(await guard.canActivate(context)).toBe(true);
      expect(prisma.businessMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_businessId: { userId: id, businessId: id } },
        }),
      );
    },
  );
  it('rechecks membership on every request, without trusting JWT role fields', async () => {
    expect(await guard.canActivate(context)).toBe(true);
    prisma.businessMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      isActive: false,
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.businessMember.findUnique).toHaveBeenCalledTimes(2);
  });
  it('resolves indirect imports with only businessId selected', async () => {
    scope = 'import';
    request.params = { importId: id };
    prisma.importJob.findUnique.mockResolvedValue({ businessId: id });
    expect(await guard.canActivate(context)).toBe(true);
    expect(prisma.importJob.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: { businessId: true },
    });
  });
  it('hides nonexistent imports', async () => {
    scope = 'import';
    request.params = { importId: id };
    prisma.importJob.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('limits authentication attempts without trusting forwarded IP headers', async () => {
    let count = 0;
    const rate = new AuthRateGuard(
      { consume: async () => ({ allowed: ++count <= 10, retryAfter: 60 }) },
      new ConfigService({ JWT_SECRET: randomBytes(48).toString('base64') }),
    );
    const rateContext = {
      ...context,
      getHandler: () => function register() {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    for (let i = 0; i < 10; i++)
      expect(await rate.canActivate(rateContext)).toBe(true);
    await expect(rate.canActivate(rateContext)).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMITED',
    });
  });
});

describe('Authentication request boundaries and configuration', () => {
  const valid = {
    email: ' Owner@Example.com ',
    password: 'SecurePassword123!',
  };
  const errors = (body: object, registration = true) =>
    validateSync(plainToInstance(registration ? RegisterDto : LoginDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  it('normalizes email without modifying passwords', () => {
    const dto = plainToInstance(RegisterDto, valid);
    expect(dto.email).toBe('owner@example.com');
    expect(dto.password).toBe(valid.password);
    expect(errors(valid)).toEqual([]);
  });
  it.each([
    { email: '' },
    { email: 'bad' },
    { email: 'é@example.com' },
    { email: `${'x'.repeat(255)}@example.com` },
    { password: '' },
    { password: 'short' },
    { password: 'x'.repeat(129) },
    { password: 'Aa1' + 'x'.repeat(126) },
    { password: 'Aa1' + 'x'.repeat(9997) },
    { password: 'Aa1' + '\u{1F600}'.repeat(63) },
    { password: 'Aa1' + 'a\uFE0F'.repeat(63) },
    { password: 'onlylowercase' },
    { password: 'NoNumbersHere' },
    { role: 'OWNER' },
    { userId: 'id' },
    { businessId: 'id' },
    { passwordHash: 'hash' },
  ])('rejects invalid or privileged input %#', (body) => {
    expect(errors({ ...valid, ...body }).length).toBeGreaterThan(0);
  });
  it('permits weak but bounded passwords at login for generic credential errors', () => {
    expect(errors({ ...valid, password: 'bad' }, false)).toEqual([]);
  });
  it('accepts a strong password exactly at the 128-character boundary', () => {
    const body = { ...valid, password: 'Aa1' + 'x'.repeat(125) };
    expect(errors(body)).toEqual([]);
    expect(errors(body, false)).toEqual([]);
    expect(
      errors({ ...body, password: body.password + 'x' }, false).length,
    ).toBeGreaterThan(0);
  });
  it('applies identical UTF-16 length bounds to Unicode passwords at registration and login', () => {
    const body = { ...valid, password: 'Aa1x' + '\u{1F600}'.repeat(62) };
    expect(body.password.length).toBe(128);
    expect(errors(body)).toEqual([]);
    expect(errors(body, false)).toEqual([]);
    expect(
      errors({ ...body, password: body.password + 'x' }).length,
    ).toBeGreaterThan(0);
    expect(
      errors({ ...body, password: body.password + 'x' }, false).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    { JWT_SECRET: '', JWT_ISSUER: '', JWT_AUDIENCE: '' },
    { JWT_SECRET: 'short', JWT_ISSUER: 'i', JWT_AUDIENCE: 'a' },
  ])('fails startup with invalid config %#', (values) => {
    expect(() => jwtConfig(new ConfigService(values))).toThrow('JWT_SECRET');
  });
});

describe('Complete controller authorization policy inventory', () => {
  const source = resolve(__dirname, '../../src');
  const routes: { label: string; scope: Scope | undefined }[] = [];
  for (const file of readdirSync(source, { recursive: true }) as string[]) {
    if (!file.endsWith('.controller.ts')) continue;
    const exports = require(resolve(source, file)) as Record<string, Function>;
    for (const controller of Object.values(exports)) {
      if (!controller.prototype) continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = controller.prototype[name] as Function;
        if (
          typeof handler !== 'function' ||
          !Reflect.hasMetadata(PATH_METADATA, handler)
        )
          continue;
        routes.push({
          label: `${controller.name}.${name}`,
          scope:
            Reflect.getMetadata(AUTH_SCOPE, handler) ??
            Reflect.getMetadata(AUTH_SCOPE, controller),
        });
      }
    }
  }
  it.each(routes)('$label declares an explicit scope', ({ label, scope }) => {
    expect([
      'public',
      'identity',
      'params',
      'body',
      'query',
      'import',
    ]).toContain(scope);
    if (scope === 'public')
      expect([
        'AuthController.register',
        'AuthController.login',
        'AuthController.refresh',
        'AuthController.logout',
        'AuthController.forgotPassword',
        'AuthController.resetPassword',
      ]).toContain(label);
  });
  it('covers all 48 current endpoints and only six public token/credential operations', () => {
    expect(routes).toHaveLength(48);
    expect(routes.filter((route) => route.scope === 'public')).toHaveLength(6);
  });
});
