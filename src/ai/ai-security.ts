import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { identifier, object } from './ai-response';
import type { AiMessage } from './ai-conversation.store';

export const unavailable = (message = 'AI integration is unavailable') =>
  new AppHttpException(
    ErrorCode.HTTP_ERROR,
    HttpStatus.SERVICE_UNAVAILABLE,
    message,
  );
export const denied = () =>
  new AppHttpException(
    ErrorCode.UNAUTHORIZED,
    HttpStatus.UNAUTHORIZED,
    'Invalid AI service context',
  );
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const same = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export interface AiClaims {
  iss: 'brandora-backend';
  aud: 'brandora-ai-tools-v1';
  scope: 'products:read conversations:read';
  businessId: string;
  customerId: string;
  conversationId: string;
  messageId: string;
  requestHash: string;
  iat: number;
  exp: number;
}

@Injectable()
export class AiSecurity {
  constructor(private readonly config: ConfigService) {}
  settings() {
    if (this.config.get('AI_INTEGRATION_ENABLED') !== 'true')
      throw unavailable();
    const inbound = this.config.get<string>('BACKEND_SERVICE_TOKEN') ?? '';
    const outbound = this.config.get<string>('AI_SERVICE_TOKEN') ?? '';
    const valid = (v: string) => /^[\x21-\x7e]{32,4096}$/.test(v);
    try {
      if (!valid(inbound) || !valid(outbound) || same(inbound, outbound))
        throw new Error();
      const key = createPrivateKey(
        (this.config.get<string>('AI_CONTEXT_PRIVATE_KEY') ?? '').replace(
          /\\n/g,
          '\n',
        ),
      );
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
      const url = new URL(this.config.get<string>('AI_BASE_URL') ?? '');
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        !(
          url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
      )
        throw new Error();
      return { inbound, outbound, key, origin: url.origin };
    } catch {
      throw unavailable();
    }
  }
  issue(message: AiMessage, body: string) {
    const { key } = this.settings();
    const now = Math.floor(Date.now() / 1000);
    const claims: AiClaims = {
      iss: 'brandora-backend',
      aud: 'brandora-ai-tools-v1',
      scope: 'products:read conversations:read',
      businessId: message.businessId,
      customerId: message.customerId,
      conversationId: message.conversationId,
      messageId: message.messageId,
      requestHash: digest(body),
      iat: now,
      exp: now + 60,
    };
    const payload = [
      JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
      JSON.stringify(claims),
    ]
      .map((v) => Buffer.from(v).toString('base64url'))
      .join('.');
    return (
      payload +
      '.' +
      sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')
    );
  }
  authenticate(authorization: unknown, token: unknown): AiClaims {
    const { inbound, key } = this.settings();
    try {
      if (
        typeof authorization !== 'string' ||
        authorization.length > 4103 ||
        !same(authorization, 'Bearer ' + inbound) ||
        typeof token !== 'string' ||
        token.length > 8192 ||
        !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
      )
        throw new Error();
      const parts = token.split('.');
      if (
        !verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          createPublicKey(key),
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw new Error();
      const header: unknown = JSON.parse(
        Buffer.from(parts[0], 'base64url').toString(),
      );
      const c: unknown = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString(),
      );
      const keys = [
        'iss',
        'aud',
        'scope',
        'businessId',
        'customerId',
        'conversationId',
        'messageId',
        'requestHash',
        'iat',
        'exp',
      ];
      if (
        !object(header) ||
        header.alg !== 'RS256' ||
        header.typ !== 'JWT' ||
        Object.keys(header).length !== 2 ||
        !object(c) ||
        Object.keys(c).length !== keys.length ||
        !keys.every((k) => k in c) ||
        c.iss !== 'brandora-backend' ||
        c.aud !== 'brandora-ai-tools-v1' ||
        c.scope !== 'products:read conversations:read' ||
        !['businessId', 'customerId', 'conversationId', 'messageId'].every(
          (k) => identifier(c[k]),
        ) ||
        typeof c.requestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(c.requestHash) ||
        !Number.isSafeInteger(c.iat) ||
        !Number.isSafeInteger(c.exp) ||
        Number(c.iat) < 0 ||
        Number(c.iat) > Date.now() / 1000 ||
        Number(c.exp) <= Date.now() / 1000 ||
        Number(c.exp) > Number(c.iat) + 60
      )
        throw new Error();
      return c as unknown as AiClaims;
    } catch {
      throw denied();
    }
  }
}
