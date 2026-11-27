import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AuthRateStore } from '../../src/auth/auth-rate.store';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/products/images/cloudinary.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { Prisma } from '../../src/generated/prisma/client';
import { ReplyRecoveryService } from '../../src/ai-replies/reply-recovery.service';

const userId = '10000000-0000-4000-8000-000000000001';
const businessId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const other = '90000000-0000-4000-8000-000000000001';
const path = `/businesses/${businessId}`;
const oldPassword = 'SyntheticOldPassword9';
const nextPassword = 'SyntheticNewPassword8';
const jpeg = Buffer.from([255, 216, 255, 224]);
const knownError = () =>
  new Prisma.PrismaClientKnownRequestError('Missing', {
    code: 'P2025',
    clientVersion: '7.10.1',
  });

describe('Account and Business settings: real module/guards, synthetic persistence/cloud', () => {
  let app: INestApplication;
  let token: string;
  let user: any;
  let business: any;
  let settings: any;
  let session: any;
  let faqRows: any[];
  let cleanupRows: any[];
  let oldHash: string;
  const pick = (row: any, select: any) =>
    !row
      ? null
      : !select
        ? { ...row }
        : Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  const scoped = (rows: any[], where: any) =>
    rows.filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    );
  const cloud = {
    assertReady: jest.fn(),
    upload: jest.fn(),
    destroy: jest.fn(),
  };
  const rate = { consume: jest.fn() };
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    authSession: { findUnique: jest.fn(), updateMany: jest.fn() },
    businessMember: { findUnique: jest.fn() },
    business: { findUnique: jest.fn(), update: jest.fn() },
    businessSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    businessFaq: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    businessLogoCleanup: {
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    passwordResetToken: { deleteMany: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  beforeAll(async () => {
    oldHash = await argon2.hash(oldPassword);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(CloudinaryService)
      .useValue(cloud)
      .overrideProvider(AuthRateStore)
      .useValue(rate)
      .overrideProvider(ReplyRecoveryService)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: userId, sid: sessionId, ver: 0 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    user = {
      id: userId,
      email: 'owner@synthetic.invalid',
      name: null,
      authVersion: 0,
      passwordHash: oldHash,
      memberships: [],
    };
    business = {
      id: businessId,
      name: 'Synthetic store',
      logoUrl: null,
      logoPublicId: null,
    };
    settings = {
      businessId,
      acceptsCash: true,
      acceptsOnlinePayment: false,
      deliveryEnabled: false,
      pickupEnabled: true,
      returnPolicy: null,
      paymentNotes: null,
      deliveryNotes: null,
      deliveryFee: null,
    };
    session = {
      userId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60000),
    };
    faqRows = [];
    cleanupRows = [];
    prisma.user.findUnique.mockImplementation(async ({ where, select }: any) =>
      pick(where.id === userId ? user : null, select),
    );
    prisma.user.findUniqueOrThrow.mockImplementation(async () => ({ ...user }));
    prisma.user.update.mockImplementation(async ({ data, select }: any) => {
      Object.assign(user, data, {
        authVersion: data.authVersion ? user.authVersion + 1 : user.authVersion,
      });
      return pick(user, select);
    });
    prisma.authSession.findUnique.mockImplementation(async () => ({
      ...session,
    }));
    prisma.authSession.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(session, data);
      return { count: 1 };
    });
    prisma.businessMember.findUnique.mockImplementation(
      async ({ where }: any) =>
        where.userId_businessId.businessId === businessId
          ? { role: 'OWNER', isActive: true }
          : null,
    );
    prisma.business.findUnique.mockImplementation(
      async ({ where, select }: any) =>
        pick(where.id === businessId ? business : null, select),
    );
    prisma.business.update.mockImplementation(async ({ data, select }: any) => {
      Object.assign(business, data);
      return pick(business, select);
    });
    prisma.businessSettings.findUnique.mockImplementation(async () => ({
      ...settings,
    }));
    prisma.businessSettings.upsert.mockImplementation(
      async ({ update }: any) => {
        Object.assign(settings, update);
        return { ...settings };
      },
    );
    prisma.businessFaq.count.mockImplementation(
      async ({ where }: any) => scoped(faqRows, where).length,
    );
    prisma.businessFaq.findMany.mockImplementation(
      async ({ where, take, skip }: any) =>
        scoped(faqRows, where)
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
          .slice(skip, skip + take),
    );
    prisma.businessFaq.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `40000000-0000-4000-8000-${String(faqRows.length + 1).padStart(12, '0')}`,
        position: 0,
        isActive: true,
        ...Object.fromEntries(
          Object.entries(data).filter(([, v]) => v !== undefined),
        ),
      };
      faqRows.push(row);
      return row;
    });
    prisma.businessFaq.update.mockImplementation(
      async ({ where, data }: any) => {
        const row = scoped(faqRows, where)[0];
        if (!row) throw knownError();
        Object.assign(
          row,
          Object.fromEntries(
            Object.entries(data).filter(([, v]) => v !== undefined),
          ),
        );
        return row;
      },
    );
    prisma.businessFaq.delete.mockImplementation(async ({ where }: any) => {
      const row = scoped(faqRows, where)[0];
      if (!row) throw knownError();
      faqRows.splice(faqRows.indexOf(row), 1);
      return row;
    });
    prisma.businessLogoCleanup.create.mockImplementation(
      async ({ data }: any) => {
        cleanupRows.push({ status: 'UPLOADING', ...data });
        return data;
      },
    );
    prisma.businessLogoCleanup.upsert.mockImplementation(
      async ({ where, create, update }: any) => {
        const row = scoped(cleanupRows, where)[0];
        if (row) {
          Object.assign(row, update);
          return row;
        }
        cleanupRows.push(create);
        return create;
      },
    );
    prisma.businessLogoCleanup.update.mockImplementation(
      async ({ where, data }: any) => {
        const row = scoped(cleanupRows, where)[0];
        if (!row) throw knownError();
        Object.assign(row, data);
        return row;
      },
    );
    prisma.businessLogoCleanup.delete.mockImplementation(
      async ({ where }: any) => {
        const row = scoped(cleanupRows, where)[0];
        if (!row) throw knownError();
        cleanupRows.splice(cleanupRows.indexOf(row), 1);
        return row;
      },
    );
    prisma.businessLogoCleanup.deleteMany.mockImplementation(
      async ({ where }: any) => {
        const rows = scoped(cleanupRows, where);
        cleanupRows = cleanupRows.filter((r) => !rows.includes(r));
        return { count: rows.length };
      },
    );
    prisma.businessLogoCleanup.findMany.mockImplementation(
      async ({ where }: any) => scoped(cleanupRows, where),
    );
    prisma.businessLogoCleanup.count.mockImplementation(
      async ({ where }: any) => scoped(cleanupRows, where).length,
    );
    prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$queryRaw.mockResolvedValue([{ id: userId }]);
    prisma.$transaction.mockImplementation(async (work: any) => {
      const before = structuredClone({ user, session, business, cleanupRows });
      try {
        return await work(prisma);
      } catch (e) {
        ({ user, session, business, cleanupRows } = before);
        throw e;
      }
    });
    cloud.assertReady.mockReturnValue(undefined);
    cloud.upload.mockResolvedValue({
      secureUrl: 'https://res.cloudinary.com/synthetic/image/upload/logo.jpg',
      width: 40,
      height: 40,
      bytes: 4,
      format: 'jpg',
    });
    cloud.destroy.mockResolvedValue('ok');
    rate.consume.mockResolvedValue({ allowed: true, retryAfter: 0 });
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('reads and updates only the current account name without exposing credentials', async () => {
    await request(app.getHttpServer())
      .patch('/auth/me')
      .set(auth())
      .send({ name: '  شرُوق  ' })
      .expect(200, { id: userId, email: user.email, name: 'شرُوق' });
    const r = await request(app.getHttpServer())
      .get('/auth/me')
      .set(auth())
      .expect(200);
    expect(r.body).toMatchObject({ name: 'شرُوق', businesses: [] });
    expect(r.body.passwordHash).toBeUndefined();
    expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id: userId });
  });
  it.each([
    {},
    { name: '' },
    { name: '   ' },
    { name: null },
    { name: 'x'.repeat(201) },
    { name: 'Owner', email: 'other@synthetic.invalid' },
    { name: 'Owner', avatarUrl: 'https://synthetic.invalid/x' },
  ])('rejects invalid or forbidden account edits %#', async (body) => {
    await request(app.getHttpServer())
      .patch('/auth/me')
      .set(auth())
      .send(body)
      .expect(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('changes an Argon2 password and atomically revokes all sessions and outstanding reset codes', async () => {
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(auth())
      .send({ currentPassword: oldPassword, newPassword: nextPassword })
      .expect(204);
    expect(await argon2.verify(user.passwordHash, nextPassword)).toBe(true);
    expect(await argon2.verify(user.passwordHash, oldPassword)).toBe(false);
    expect(user.authVersion).toBe(1);
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId },
    });
    await request(app.getHttpServer()).get('/auth/me').set(auth()).expect(401);
    expect(rate.consume.mock.calls[0][0]).toHaveLength(2);
  });
  it('rejects a wrong current password without writes', async () => {
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(auth())
      .send({ currentPassword: 'WrongPassword9', newPassword: nextPassword })
      .expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(user.passwordHash).toBe(oldHash);
  });
  it.each(['short', 'lowercasepassword9', oldPassword])(
    'rejects invalid or unchanged new password',
    async (newPassword) => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set(auth())
        .send({ currentPassword: oldPassword, newPassword })
        .expect(400);
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );
  it('rejects a password reset race after initial verification', async () => {
    prisma.user.findUniqueOrThrow.mockImplementationOnce(async () => ({
      ...user,
      authVersion: 1,
    }));
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(auth())
      .send({ currentPassword: oldPassword, newPassword: nextPassword })
      .expect(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('rolls back password/session changes if reset-code invalidation fails', async () => {
    prisma.passwordResetToken.deleteMany.mockRejectedValueOnce(
      new Error('synthetic database failure'),
    );
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(auth())
      .send({ currentPassword: oldPassword, newPassword: nextPassword })
      .expect(500);
    expect(user.passwordHash).toBe(oldHash);
    expect(user.authVersion).toBe(0);
    expect(session.revokedAt).toBeNull();
  });
  it('honors password-change rate limits before hashing/writes', async () => {
    rate.consume.mockResolvedValueOnce({ allowed: false, retryAfter: 90 });
    const r = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(auth())
      .send({ currentPassword: oldPassword, newPassword: nextPassword })
      .expect(429);
    expect(r.headers['retry-after']).toBe('90');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('saves exact owner policy text, decimal strings and null without inventing defaults', async () => {
    const policy = 'الاستبدال خلال 7 أيام للقطعة غير المستخدمة.';
    const r = await request(app.getHttpServer())
      .patch(path + '/settings')
      .set(auth())
      .send({
        returnPolicy: policy,
        paymentNotes: 'InstaPay يدوي فقط',
        deliveryNotes: 'حسب المنطقة',
        deliveryFee: '35.5',
      })
      .expect(200);
    expect(r.body).toMatchObject({
      returnPolicy: policy,
      deliveryFee: '35.50',
      acceptsOnlinePayment: false,
    });
    await request(app.getHttpServer())
      .patch(path + '/settings')
      .set(auth())
      .send({ deliveryFee: null, returnPolicy: null })
      .expect(200);
    const saved = await request(app.getHttpServer())
      .get(path + '/settings')
      .set(auth())
      .expect(200);
    expect(saved.body).toMatchObject({
      deliveryFee: null,
      returnPolicy: null,
      paymentNotes: 'InstaPay يدوي فقط',
    });
  });
  it.each([
    { deliveryFee: 35 },
    { deliveryFee: '-1' },
    { deliveryFee: '1.234' },
    { returnPolicy: 42 },
    { returnPolicy: 'x'.repeat(5001) },
    { businessDescription: 'duplicate description' },
  ])('rejects invalid policy input %#', async (body) => {
    await request(app.getHttpServer())
      .patch(path + '/settings')
      .set(auth())
      .send(body)
      .expect(400);
    expect(prisma.businessSettings.upsert).not.toHaveBeenCalled();
  });
  it('creates, pages, edits and deletes scoped FAQ answers without changing their meaning', async () => {
    const create = await request(app.getHttpServer())
      .post(path + '/faqs')
      .set(auth())
      .send({
        question: '  الاستبدال خلال كام يوم؟  ',
        answer: 'خلال 7 أيام',
        position: 2,
      })
      .expect(201);
    expect(create.body.question).toBe('الاستبدال خلال كام يوم؟');
    await request(app.getHttpServer())
      .post(path + '/faqs')
      .set(auth())
      .send({ question: 'الدفع؟', answer: 'كاش فقط', position: 1 })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get(path + '/faqs?limit=1&offset=0')
      .set(auth())
      .expect(200);
    expect(list.body.items[0].position).toBe(1);
    expect(list.body.pagination).toMatchObject({
      totalCount: 2,
      hasMore: true,
      nextOffset: 1,
    });
    await request(app.getHttpServer())
      .patch(path + '/faqs/' + create.body.id)
      .set(auth())
      .send({ answer: 'خلال 14 يوم', isActive: false })
      .expect(200);
    expect(faqRows[0]).toMatchObject({
      answer: 'خلال 14 يوم',
      isActive: false,
    });
    await request(app.getHttpServer())
      .delete(path + '/faqs/' + create.body.id)
      .set(auth())
      .expect(204);
    expect(faqRows).toHaveLength(1);
  });
  it.each([
    {},
    { question: '', answer: 'valid' },
    { question: 'valid', answer: null },
    { question: 'valid', answer: '   ' },
    { question: 'valid', answer: 'valid', position: -1 },
  ])('rejects invalid FAQ create %#', async (body) => {
    await request(app.getHttpServer())
      .post(path + '/faqs')
      .set(auth())
      .send(body)
      .expect(400);
    expect(prisma.businessFaq.create).not.toHaveBeenCalled();
  });
  it('hides FAQs belonging to another business on both edit and delete', async () => {
    faqRows.push({
      id: other,
      businessId: other,
      question: 'Private',
      answer: 'Do not expose',
    });
    await request(app.getHttpServer())
      .patch(path + '/faqs/' + other)
      .set(auth())
      .send({ answer: 'x' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(path + '/faqs/' + other)
      .set(auth())
      .expect(404);
    expect(faqRows).toHaveLength(1);
  });
  it('uploads/replaces/deletes only the business logo and cleans obsolete assets', async () => {
    const r = await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(r.body).toMatchObject({
      logoUrl: expect.stringContaining('https://'),
      cleanupPending: false,
    });
    const old = business.logoPublicId;
    expect(old).toContain('/' + businessId + '/logo/');
    await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(cloud.destroy).toHaveBeenCalledWith(old);
    const profile = await request(app.getHttpServer())
      .get(path)
      .set(auth())
      .expect(200);
    expect(profile.body.logoPublicId).toBeUndefined();
    expect(profile.body.logoUrl).toBeTruthy();
    await request(app.getHttpServer())
      .delete(path + '/logo')
      .set(auth())
      .expect(200, { logoUrl: null, cleanupPending: false });
    expect(cleanupRows).toHaveLength(0);
  });
  it('retains failed cleanup for an owner retry while keeping the replacement logo valid', async () => {
    business.logoPublicId = 'brandora/businesses/synthetic/old';
    cloud.destroy.mockRejectedValue(new Error('synthetic provider failure'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const r = await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(r.body.cleanupPending).toBe(true);
    expect(cleanupRows[0].status).toBe('PENDING');
    cloud.destroy.mockResolvedValue('ok');
    await request(app.getHttpServer())
      .delete(path + '/logo')
      .set(auth())
      .expect(200, { logoUrl: null, cleanupPending: false });
    jest.restoreAllMocks();
  });
  it('preserves the old logo and compensates a failed replacement database write', async () => {
    business.logoPublicId = 'old-logo';
    business.logoUrl = 'https://synthetic.invalid/old';
    prisma.business.update.mockRejectedValueOnce(
      new Error('synthetic db failure'),
    );
    await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(503);
    expect(business.logoPublicId).toBe('old-logo');
    expect(cloud.destroy).not.toHaveBeenCalledWith('old-logo');
    expect(cleanupRows).toHaveLength(0);
  });
  it('rejects spoofed/oversized logos before storage reservation or provider calls', async () => {
    await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', Buffer.from('<svg/>'), {
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400);
    await request(app.getHttpServer())
      .put(path + '/logo')
      .set(auth())
      .attach('file', Buffer.alloc(10_000_001), {
        filename: 'logo.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(prisma.businessLogoCleanup.create).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated and foreign-business requests before service operations', async () => {
    await request(app.getHttpServer())
      .patch('/auth/me')
      .send({ name: 'x' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .send({ currentPassword: oldPassword, newPassword: nextPassword })
      .expect(401);
    for (const route of ['settings', 'faqs', 'logo'])
      await request(app.getHttpServer())
        .get(`/businesses/${other}/${route === 'logo' ? '' : route}`)
        .set(auth())
        .expect(404);
    await request(app.getHttpServer())
      .put(`/businesses/${other}/logo`)
      .set(auth())
      .attach('file', jpeg, { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(404);
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(prisma.businessSettings.upsert).not.toHaveBeenCalled();
  });
});
