import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import proxyaddr from 'proxy-addr';
import ipaddr from 'ipaddr.js';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { AuthRequest } from './auth-policy';
import { AuthRateStore, RateResult, RateRule } from './auth-rate.store';

const policies: Record<
  string,
  { ip: number; account: number; seconds: number; ipSeconds?: number }
> = {
  register: { ip: 10, account: 3, seconds: 3600, ipSeconds: 60 },
  login: { ip: 30, account: 10, seconds: 900, ipSeconds: 60 },
  refresh: { ip: 60, account: 30, seconds: 60 },
  logout: { ip: 60, account: 30, seconds: 60 },
  forgotPassword: { ip: 10, account: 3, seconds: 900 },
  resetPassword: { ip: 10, account: 5, seconds: 900 },
};
@Injectable()
export class AuthRateGuard implements CanActivate {
  private readonly trust: (ip: string, index: number) => boolean;
  private readonly secret: string;
  constructor(
    private readonly store: AuthRateStore,
    config: ConfigService,
  ) {
    const cidrs = (config.get<string>('AUTH_TRUSTED_PROXY_CIDRS') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    this.trust = cidrs.length ? proxyaddr.compile(cidrs) : () => false;
    const key =
      config.get<string>('AUTH_RATE_LIMIT_SECRET') ||
      config.get<string>('JWT_SECRET');
    if (!key || Buffer.byteLength(key) < 32)
      throw new Error(
        'Authentication rate-limit signing key must be at least 32 bytes',
      );
    this.secret = createHmac('sha256', key)
      .update('brandora-rate-limit-v1')
      .digest('hex');
  }
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    const action = context.getHandler().name;
    const policy = policies[action];
    if (!policy) throw new Error('Missing authentication rate-limit policy');
    let client: string;
    try {
      const peer = request.socket.remoteAddress ?? '';
      if (
        this.trust(peer, 0) &&
        String(request.headers['x-forwarded-for'] ?? '').length > 1024
      )
        throw new Error('Oversized proxy header');
      client = ipaddr
        .process(proxyaddr(request as unknown as IncomingMessage, this.trust))
        .toString();
    } catch {
      throw new AppHttpException(
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
        'Invalid client network information',
      );
    }
    const hash = (value: string) =>
      createHmac('sha256', this.secret).update(value).digest('hex');
    const rules: RateRule[] = [
      {
        key: hash(`${action}:ip:${client}`),
        limit: policy.ip,
        seconds: policy.ipSeconds ?? policy.seconds,
      },
    ];
    const body = request.body;
    const account =
      typeof body?.email === 'string'
        ? body.email.trim().toLowerCase().slice(0, 254)
        : typeof body?.refreshToken === 'string'
          ? body.refreshToken.slice(0, 128)
          : typeof body?.token === 'string'
            ? body.token.slice(0, 128)
            : undefined;
    if (account)
      rules.push({
        key: hash(`${action}:account:${account}`),
        limit: policy.account,
        seconds: policy.seconds,
      });
    let result: RateResult;
    try {
      result = await this.store.consume(rules);
    } catch {
      response.setHeader('Retry-After', '5');
      throw new AppHttpException(
        ErrorCode.AUTH_RATE_LIMIT_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Authentication is temporarily unavailable; retry later',
      );
    }
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfter));
      throw new AppHttpException(
        ErrorCode.AUTH_RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many authentication attempts; retry later',
      );
    }
    return true;
  }
}
