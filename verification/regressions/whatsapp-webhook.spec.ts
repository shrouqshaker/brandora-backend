import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { InboundWebhookService } from '../../src/whatsapp/inbound-webhook.service';
import { WhatsAppSenderService } from '../../src/whatsapp/whatsapp-sender.service';
import { WhatsAppSettings } from '../../src/whatsapp/whatsapp-settings';
import { isValidWhatsAppSignature } from '../../src/whatsapp/whatsapp-signature';
import { WhatsAppWebhookController } from '../../src/whatsapp/whatsapp-webhook.controller';

// The webhook door only: Meta's two proofs and the on/off switch.
// No database: storing is tested in verification/whatsapp-postgres.cjs.
const SECRET = 'test-app-secret-0123456789';
const VERIFY = 'test-verify-token-0123456789';
const sign = (body: Buffer | string, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('isValidWhatsAppSignature', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it('accepts the signature Meta would send', () => {
    expect(isValidWhatsAppSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects another secret, a changed body and broken headers', () => {
    expect(
      isValidWhatsAppSignature(body, sign(body, 'another-secret'), SECRET),
    ).toBe(false);
    expect(
      isValidWhatsAppSignature(Buffer.from(body + ' '), sign(body), SECRET),
    ).toBe(false);
    for (const header of [undefined, '', 'sha256=abc', sign(body).slice(7)])
      expect(isValidWhatsAppSignature(body, header, SECRET)).toBe(false);
    expect(isValidWhatsAppSignature(undefined, sign(body), SECRET)).toBe(false);
  });
});

describe('WhatsApp webhook HTTP', () => {
  let app: INestApplication;
  let env: Record<string, string>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        WhatsAppSettings,
        { provide: InboundWebhookService, useValue: { store: async () => [] } },
        { provide: WhatsAppSenderService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
  });
  beforeEach(() => {
    env = {
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_VERIFY_TOKEN: VERIFY,
      WHATSAPP_APP_SECRET: SECRET,
    };
  });
  afterAll(() => app.close());

  const verify = (token: string) =>
    request(app.getHttpServer()).get('/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': '1158201444',
    });

  it('GET returns the challenge as plain text when the token matches', async () => {
    const res = await verify(VERIFY).expect(200);
    expect(res.text).toBe('1158201444');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('GET with a wrong token is 403', async () => {
    const res = await verify('wrong-token-0123456789').expect(403);
    expect(res.body.code).toBe('WHATSAPP_VERIFY_TOKEN_INVALID');
  });

  it('POST signed with the App secret is 200, anything else is 401', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' });
    const post = (signature?: string) => {
      const r = request(app.getHttpServer())
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json');
      return (signature ? r.set('X-Hub-Signature-256', signature) : r).send(
        body,
      );
    };
    expect((await post(sign(body)).expect(200)).body).toEqual({
      received: true,
    });
    expect((await post().expect(401)).body.code).toBe(
      'WHATSAPP_SIGNATURE_INVALID',
    );
    expect((await post(sign(body, 'not-meta')).expect(401)).body.code).toBe(
      'WHATSAPP_SIGNATURE_INVALID',
    );
  });

  it('both answer 503 while WhatsApp is switched off or a secret is missing', async () => {
    env.WHATSAPP_ENABLED = 'false';
    expect((await verify(VERIFY).expect(503)).body.code).toBe(
      'WHATSAPP_UNAVAILABLE',
    );
    env = { WHATSAPP_ENABLED: 'true', WHATSAPP_VERIFY_TOKEN: VERIFY };
    const body = '{}';
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body)
      .expect(503);
    expect(res.body.code).toBe('WHATSAPP_UNAVAILABLE');
  });
});
