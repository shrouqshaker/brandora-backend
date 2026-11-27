import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BusinessesModule } from '../../src/businesses/businesses.module';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { DayOfWeek, Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AppModule } from '../../src/app.module';
import { BusinessesService } from '../../src/businesses/businesses.service';
import { ProductAccessService } from '../../src/products/product-access.service';
import { ProductsModule } from '../../src/products/products.module';
import { JwtService } from '@nestjs/jwt';

describe('Business profile/settings/working hours HTTP API (stateful mocked persistence)', () => {
  const id = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const otherId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const missingId = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const path = `/businesses/${id}`;
  const weekdays = Object.values(DayOfWeek);
  const defaults = {
    acceptsCash: true,
    acceptsOnlinePayment: false,
    deliveryEnabled: false,
    pickupEnabled: true,
    returnPolicy: null,
    paymentNotes: null,
    deliveryNotes: null,
    deliveryFee: null,
  };
  const week = () => ({
    days: weekdays.map((dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      opensAt: '09:00',
      closesAt: '17:30',
    })),
  });
  let app: INestApplication;
  let businesses: any[];
  let settings: any[];
  let hours: any[];
  let stagedHours: any[];
  const now = new Date('2026-10-09T10:00:00Z');
  const prisma = {
    business: { findUnique: jest.fn(), update: jest.fn() },
    businessSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    workingHour: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const tx = { workingHour: { upsert: jest.fn() } };
  const project = (row: any, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(select)
        .filter(([, include]) => include)
        .map(([key]) => [key, row[key]]),
    );
  const error = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('private SQL', {
      code,
      clientVersion: '7',
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [BusinessesModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    settings = [];
    hours = [];
    businesses = [id, otherId].map((id) => ({
      id,
      name: 'Original',
      description: 'Original description',
      category: 'Retail',
      phone: '123',
      address: 'Original address',
      logoUrl: null,
      createdAt: now,
      updatedAt: now,
      internal: 'hidden',
    }));
    prisma.business.findUnique.mockImplementation(async ({ where, select }) => {
      const row = businesses.find((row) => row.id === where.id);
      return row ? project(row, select) : null;
    });
    prisma.business.update.mockImplementation(
      async ({ where, data, select }) => {
        const row = businesses.find((row) => row.id === where.id);
        if (!row) throw error('P2025');
        Object.assign(row, data);
        return project(row, select);
      },
    );
    prisma.businessSettings.findUnique.mockImplementation(
      async ({ where, select }) => {
        const row = settings.find((row) => row.businessId === where.businessId);
        return row ? project(row, select) : null;
      },
    );
    prisma.businessSettings.upsert.mockImplementation(
      async ({ where, create, update, select }) => {
        let row = settings.find((row) => row.businessId === where.businessId);
        if (!row) {
          row = { ...create, createdAt: now, updatedAt: now };
          settings.push(row);
        } else Object.assign(row, update);
        return project(row, select);
      },
    );
    prisma.workingHour.findMany.mockImplementation(async ({ where }) =>
      hours
        .filter((row) => row.businessId === where.businessId)
        .sort(
          (a, b) =>
            weekdays.indexOf(a.dayOfWeek) - weekdays.indexOf(b.dayOfWeek),
        ),
    );
    tx.workingHour.upsert.mockImplementation(
      async ({ where, create, update }) => {
        const scope = where.businessId_dayOfWeek;
        let row = stagedHours.find(
          (row) =>
            row.businessId === scope.businessId &&
            row.dayOfWeek === scope.dayOfWeek,
        );
        if (!row) {
          row = {
            id: scope.businessId + scope.dayOfWeek,
            ...create,
            createdAt: now,
            updatedAt: now,
          };
          stagedHours.push(row);
        } else Object.assign(row, update);
        return row;
      },
    );
    prisma.$transaction.mockImplementation(async (callback) => {
      stagedHours = hours.map((row) => ({ ...row }));
      const result = await callback(tx);
      hours = stagedHours;
      return result;
    });
  });
  afterAll(async () => {
    await app.close();
  });
  async function expectCode(call: request.Test, status: number, code: string) {
    const response = await call.expect(status);
    expect(response.body).toMatchObject({ statusCode: status, code });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/private|SQL/);
    if (code === 'BUSINESS_NOT_FOUND')
      expect(response.body).toEqual({
        statusCode: 404,
        code,
        message: 'Business not found',
        error: 'Not Found',
      });
  }
  it('returns only profile fields and preserves owner language', async () => {
    businesses[0].name = 'اسم النشاط';
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(
      [
        'id',
        'name',
        'description',
        'category',
        'phone',
        'address',
        'logoUrl',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(response.body.name).toBe('اسم النشاط');
    expect(prisma.business.update).not.toHaveBeenCalled();
  });
  it('PATCH preserves omitted fields, trims name, and clears nullable metadata explicitly', async () => {
    const response = await request(app.getHttpServer())
      .patch(path)
      .send({ name: ' New ', phone: null })
      .expect(200);
    expect(response.body).toMatchObject({
      name: 'New',
      phone: null,
      description: 'Original description',
      address: 'Original address',
      category: 'Retail',
    });
    await request(app.getHttpServer())
      .patch(path)
      .send({ description: null, category: null, address: null })
      .expect(200);
    expect(businesses[0]).toMatchObject({
      description: null,
      category: null,
      address: null,
    });
    expect(businesses[1].name).toBe('Original');
  });
  it.each([
    {},
    { name: null },
    { name: ' ' },
    { name: 12 },
    { name: 'x'.repeat(201) },
    { description: 'x'.repeat(5001) },
    { phone: 'x'.repeat(51) },
    { address: 'x'.repeat(1001) },
    { category: 'x'.repeat(201) },
    { deliveryEnabled: true },
    { description: [] },
  ])('rejects invalid profile PATCH %j', async (body) => {
    await expectCode(
      request(app.getHttpServer()).patch(path).send(body),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.business.update).not.toHaveBeenCalled();
  });
  it('returns settings defaults without persistence, then partial PATCH maintains exactly one row', async () => {
    const initial = await request(app.getHttpServer())
      .get(path + '/settings')
      .expect(200);
    expect(initial.body).toEqual({ businessId: id, ...defaults });
    expect(settings).toEqual([]);
    expect(prisma.businessSettings.upsert).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .patch(path + '/settings')
      .send({ deliveryEnabled: true })
      .expect(200);
    const next = await request(app.getHttpServer())
      .patch(path + '/settings')
      .send({ acceptsCash: false })
      .expect(200);
    expect(next.body).toEqual({
      businessId: id,
      ...defaults,
      deliveryEnabled: true,
      acceptsCash: false,
    });
    expect(settings).toHaveLength(1);
    const current = await request(app.getHttpServer())
      .get(path + '/settings')
      .expect(200);
    expect(current.body).toEqual(next.body);
    const other = await request(app.getHttpServer())
      .get(`/businesses/${otherId}/settings`)
      .expect(200);
    expect(other.body).toEqual({ businessId: otherId, ...defaults });
  });
  it.each(['settings get', 'settings patch', 'hours get', 'hours put'])(
    'uses exactly one root ID-only existence query before %s',
    async (operation) => {
      const http = request(app.getHttpServer());
      if (operation === 'settings get')
        await http.get(path + '/settings').expect(200);
      else if (operation === 'settings patch')
        await http
          .patch(path + '/settings')
          .send({ acceptsCash: false })
          .expect(200);
      else if (operation === 'hours get')
        await http.get(path + '/working-hours').expect(200, []);
      else
        await http
          .put(path + '/working-hours')
          .send(week())
          .expect(200);
      expect(prisma.business.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.business.findUnique).toHaveBeenCalledWith({
        where: { id },
        select: { id: true },
      });
      const next =
        operation === 'settings get'
          ? prisma.businessSettings.findUnique
          : operation === 'settings patch'
            ? prisma.businessSettings.upsert
            : operation === 'hours get'
              ? prisma.workingHour.findMany
              : prisma.$transaction;
      expect(
        prisma.business.findUnique.mock.invocationCallOrder[0],
      ).toBeLessThan(next.mock.invocationCallOrder[0]);
      if (operation === 'hours put') {
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction.mock.calls[0]).toEqual([
          expect.any(Function),
        ]);
        expect(tx.workingHour.upsert).toHaveBeenCalledTimes(7);
        expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
          tx.workingHour.upsert.mock.invocationCallOrder[0],
        );
      } else expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { acceptsCash: null },
    { acceptsCash: 'true' },
    { acceptsOnlinePayment: 1 },
    { deliveryEnabled: null },
    { pickupEnabled: [] },
    { depositRequired: true },
    { businessId: otherId },
  ])('rejects invalid settings %j', async (body) => {
    await expectCode(
      request(app.getHttpServer())
        .patch(path + '/settings')
        .send(body),
      400,
      'VALIDATION_ERROR',
    );
    expect(settings).toEqual([]);
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
    expect(prisma.businessSettings.upsert).not.toHaveBeenCalled();
  });
  it('GET hours starts empty; PUT upserts all seven days in weekday order and replaces values without replacing IDs', async () => {
    await request(app.getHttpServer())
      .get(path + '/working-hours')
      .expect(200, []);
    const schedule = week();
    schedule.days.reverse();
    const first = await request(app.getHttpServer())
      .put(path + '/working-hours')
      .send(schedule)
      .expect(200);
    expect(first.body.map((row: any) => row.dayOfWeek)).toEqual(weekdays);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const closed = {
      days: weekdays.map((dayOfWeek) => ({ dayOfWeek, isOpen: false })),
    };
    const second = await request(app.getHttpServer())
      .put(path + '/working-hours')
      .send(closed)
      .expect(200);
    expect(second.body.map((row: any) => row.id)).toEqual(
      first.body.map((row: any) => row.id),
    );
    expect(hours).toHaveLength(7);
    for (const row of second.body)
      expect(row).toMatchObject({
        isOpen: false,
        opensAt: null,
        closesAt: null,
      });
    const get = await request(app.getHttpServer())
      .get(path + '/working-hours')
      .expect(200);
    expect(get.body).toEqual(second.body);
    await request(app.getHttpServer())
      .get(`/businesses/${otherId}/working-hours`)
      .expect(200, []);
    expect(prisma.workingHour.findMany).toHaveBeenCalledWith({
      where: { businessId: id },
      orderBy: { dayOfWeek: 'asc' },
    });
  });
  it('accepts explicit null times for closed days and preserves the other business schedule', async () => {
    const otherSchedule = await request(app.getHttpServer())
      .put(`/businesses/${otherId}/working-hours`)
      .send(week())
      .expect(200);
    await request(app.getHttpServer())
      .put(path + '/working-hours')
      .send({
        days: weekdays.map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: false,
          opensAt: null,
          closesAt: null,
        })),
      })
      .expect(200);
    const other = await request(app.getHttpServer())
      .get(`/businesses/${otherId}/working-hours`)
      .expect(200);
    expect(other.body).toEqual(otherSchedule.body);
    expect(hours).toHaveLength(14);
  });
  it.each([
    'duplicate',
    'missing day',
    'extra day',
    'weekday',
    '24:00',
    '9:00',
    '09:60',
    'missing open',
    'null close',
    'same time',
    'overnight',
    'closed times',
    'unknown day field',
    'unknown root field',
    'null day',
  ])('rejects invalid weekly schedule %s before writes', async (problem) => {
    const schedule: any = week();
    if (problem === 'duplicate') schedule.days[1].dayOfWeek = 'MONDAY';
    if (problem === 'missing day') schedule.days.pop();
    if (problem === 'extra day') schedule.days.push({ ...schedule.days[0] });
    if (problem === 'weekday') schedule.days[0].dayOfWeek = 'FUNDAY';
    if (['24:00', '9:00', '09:60'].includes(problem))
      schedule.days[0].opensAt = problem;
    if (problem === 'missing open') delete schedule.days[0].opensAt;
    if (problem === 'null close') schedule.days[0].closesAt = null;
    if (problem === 'same time') schedule.days[0].closesAt = '09:00';
    if (problem === 'overnight') schedule.days[0].closesAt = '08:00';
    if (problem === 'closed times') schedule.days[0].isOpen = false;
    if (problem === 'unknown day field') schedule.days[0].timezone = 'UTC';
    if (problem === 'unknown root field') schedule.businessId = otherId;
    if (problem === 'null day') schedule.days[0] = null;
    await expectCode(
      request(app.getHttpServer())
        .put(path + '/working-hours')
        .send(schedule),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(hours).toEqual([]);
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
  });
  it('rolls back a multi-row schedule if one upsert fails', async () => {
    const initial = week();
    await request(app.getHttpServer())
      .put(path + '/working-hours')
      .send(initial)
      .expect(200);
    const before = JSON.stringify(hours);
    const original = tx.workingHour.upsert.getMockImplementation()!;
    tx.workingHour.upsert.mockImplementation(async (args) => {
      if (args.create.dayOfWeek === 'WEDNESDAY') throw new Error('private SQL');
      return original(args);
    });
    await expectCode(
      request(app.getHttpServer())
        .put(path + '/working-hours')
        .send({
          days: weekdays.map((dayOfWeek) => ({ dayOfWeek, isOpen: false })),
        }),
      500,
      'INTERNAL_SERVER_ERROR',
    );
    expect(JSON.stringify(hours)).toBe(before);
  });
  it.each([
    'get',
    'patch',
    'settings get',
    'settings patch',
    'hours get',
    'hours put',
  ])(
    'returns BUSINESS_NOT_FOUND and UUID validation for %s',
    async (endpoint) => {
      function call(businessId: string) {
        const root = `/businesses/${businessId}`;
        if (endpoint === 'patch')
          return request(app.getHttpServer()).patch(root).send({ name: 'New' });
        if (endpoint === 'settings patch')
          return request(app.getHttpServer())
            .patch(root + '/settings')
            .send({ acceptsCash: false });
        if (endpoint === 'hours put')
          return request(app.getHttpServer())
            .put(root + '/working-hours')
            .send(week());
        return request(app.getHttpServer()).get(
          root +
            (endpoint === 'settings get'
              ? '/settings'
              : endpoint === 'hours get'
                ? '/working-hours'
                : ''),
        );
      }
      await expectCode(call(missingId), 404, 'BUSINESS_NOT_FOUND');
      await expectCode(call('invalid'), 400, 'VALIDATION_ERROR');
      expect(prisma.businessSettings.upsert).not.toHaveBeenCalled();
      expect(prisma.businessSettings.findUnique).not.toHaveBeenCalled();
      expect(prisma.workingHour.findMany).not.toHaveBeenCalled();
      expect(tx.workingHour.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      if (endpoint.startsWith('settings') || endpoint.startsWith('hours')) {
        expect(prisma.business.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.business.findUnique).toHaveBeenCalledWith({
          where: { id: missingId },
          select: { id: true },
        });
      }
    },
  );
  it.each(['P2003', 'P2025'])(
    'maps %s before settings/hour writes to BUSINESS_NOT_FOUND',
    async (code) => {
      prisma.businessSettings.upsert.mockRejectedValue(error(code));
      await expectCode(
        request(app.getHttpServer())
          .patch(path + '/settings')
          .send({ acceptsCash: false }),
        404,
        'BUSINESS_NOT_FOUND',
      );
      tx.workingHour.upsert.mockRejectedValue(error(code));
      await expectCode(
        request(app.getHttpServer())
          .put(path + '/working-hours')
          .send(week()),
        404,
        'BUSINESS_NOT_FOUND',
      );
    },
  );
  it('compiles the real application, uses the exported access service, and retains owner authorization', async () => {
    const authPrisma = {
      ...prisma,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: otherId, authVersion: 0 }),
      },
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          userId: otherId,
          expiresAt: new Date('2099-01-01'),
          revokedAt: null,
        }),
      },
      businessMember: {
        findUnique: jest.fn(async ({ where }) =>
          where.userId_businessId.businessId === id
            ? { role: 'OWNER', isActive: true }
            : null,
        ),
      },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(authPrisma)
      .compile();
    const access = module
      .select(ProductsModule)
      .get(ProductAccessService, { strict: true });
    expect(
      module.select(BusinessesModule).get(BusinessesService, { strict: true }),
    ).toBeInstanceOf(BusinessesService);
    const guarded = module.createNestApplication({ logger: false });
    guarded.useGlobalFilters(
      new HttpExceptionFilter(guarded.get(HttpAdapterHost)),
    );
    const spy = jest.spyOn(access, 'business');
    try {
      await guarded.init();
      const token = await module
        .get(JwtService)
        .signAsync({ sub: otherId, sid: otherId, ver: 0 });
      const response = await request(guarded.getHttpServer())
        .get(path + '/settings')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.body).toEqual({ businessId: id, ...defaults });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(id);
      expect(authPrisma.businessMember.findUnique).toHaveBeenCalledWith({
        where: { userId_businessId: { userId: otherId, businessId: id } },
        select: { role: true, isActive: true },
      });
      jest.clearAllMocks();
      for (const suffix of ['', '/settings', '/working-hours']) {
        await request(guarded.getHttpServer())
          .get(path + suffix)
          .expect(401);
        const hidden = await request(guarded.getHttpServer())
          .get(`/businesses/${otherId}${suffix}`)
          .auth(token, { type: 'bearer' })
          .expect(404);
        expect(hidden.body).toEqual({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found',
          error: 'Not Found',
        });
      }
      expect(spy).not.toHaveBeenCalled();
      expect(prisma.business.findUnique).not.toHaveBeenCalled();
      expect(prisma.businessSettings.findUnique).not.toHaveBeenCalled();
      expect(prisma.workingHour.findMany).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await guarded.close();
    }
  });
});
