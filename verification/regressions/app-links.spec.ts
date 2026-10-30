import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuthService } from '../../src/auth/auth.service';
import { AuthRateGuard } from '../../src/auth/auth-rate.guard';

describe('Public Android App Links and existing password-reset POST', () => {
  let app: INestApplication;
  const resetPassword = jest.fn().mockResolvedValue(undefined);
  const userLookup = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ user: { findUnique: userLookup } })
      .overrideProvider(AuthService)
      .useValue({ resetPassword })
      .overrideGuard(AuthRateGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
  it('returns the exact association as anonymous JSON without redirects or database access', async () => {
    const response = await request(app.getHttpServer())
      .get('/.well-known/assetlinks.json')
      .redirects(0)
      .expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.yasminhosam.brandora',
          sha256_cert_fingerprints: [
            '51:F3:C3:2A:04:7C:8B:34:0B:24:28:DE:8F:80:6F:1F:31:96:EC:AB:93:04:FF:B6:C2:DE:E6:4B:73:56:08:2E',
          ],
        },
      },
    ]);
    expect(userLookup).not.toHaveBeenCalled();
  });
  it('does not require even a valid Authorization header for the public association', async () => {
    await request(app.getHttpServer())
      .get('/.well-known/assetlinks.json')
      .set('Authorization', 'Bearer invalid')
      .expect(200);
  });
  it('keeps identity endpoints protected', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });
  it('preserves POST reset-password DTO forwarding and 204 without redirects', async () => {
    const dto = {
      token: '00000000-0000-4000-8000-000000000000.' + 'a'.repeat(43),
      newPassword: 'TestPassword123!',
    };
    const response = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send(dto)
      .expect(204);
    expect(resetPassword).toHaveBeenCalledWith(dto);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toBe('');
  });
  it('retains validation rejection of invalid reset tokens', async () => {
    const before = resetPassword.mock.calls.length;
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'invalid', newPassword: 'TestPassword123!' })
      .expect(400);
    expect(resetPassword).toHaveBeenCalledTimes(before);
  });
});
