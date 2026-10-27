import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions } from '@nestjs/jwt';

export function jwtConfig(config: ConfigService): JwtModuleOptions {
  const secret = config.get<string>('JWT_SECRET');
  const issuer = config.get<string>('JWT_ISSUER');
  const audience = config.get<string>('JWT_AUDIENCE');
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    !issuer?.trim() ||
    !audience?.trim()
  ) {
    throw new Error(
      'JWT_SECRET (at least 32 UTF-8 bytes), JWT_ISSUER and JWT_AUDIENCE are required.',
    );
  }
  return {
    secret,
    signOptions: { algorithm: 'HS256', issuer, audience, expiresIn: 900 },
    verifyOptions: { algorithms: ['HS256'], issuer, audience, maxAge: '15m' },
  };
}
