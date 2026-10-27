const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { HttpAdapterHost } = require('@nestjs/core');
const request = require('supertest');
const {
  BusinessesController,
} = require('../dist/businesses/businesses.controller');
const { BusinessesService } = require('../dist/businesses/businesses.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const {
  HttpExceptionFilter,
} = require('../dist/common/errors/http-exception.filter');

test('Business creation, validation, and existing routes', async (t) => {
  const profiles = new Map();
  const settings = new Map();
  let writes = 0;
  const prisma = {
    business: {
      create: async ({ data }) => {
        writes++;
        const profile = {
          id: randomUUID(),
          name: data.name,
          description: data.description ?? null,
          category: data.category ?? null,
          phone: data.phone ?? null,
          address: data.address ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        profiles.set(profile.id, profile);
        settings.set(profile.id, {
          businessId: profile.id,
          ...data.settings.create,
        });
        return profile;
      },
      findUnique: async ({ where }) => profiles.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const profile = profiles.get(where.id);
        Object.assign(profile, data);
        return profile;
      },
    },
    businessSettings: {
      findUnique: async ({ where }) => settings.get(where.businessId) ?? null,
      upsert: async ({ where, create, update }) => {
        const value = settings.has(where.businessId)
          ? { ...settings.get(where.businessId), ...update }
          : create;
        settings.set(where.businessId, value);
        return value;
      },
    },
    workingHour: { findMany: async () => [] },
  };
  const module = await Test.createTestingModule({
    controllers: [BusinessesController],
    providers: [
      BusinessesService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  prisma.$transaction = async (work) => work(prisma);
  const app = module.createNestApplication({ logger: false });
  // This isolated controller regression simulates the identity normally set by AuthGuard.
  app.use((req, _res, next) => {
    req.user = { id: 'f6bc7287-3285-4e19-a819-459c41f0a138' };
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
  await app.init();
  t.after(() => app.close());
  const http = request(app.getHttpServer());
  let id;
  await t.test(
    '201 response, trimmed Arabic name, nullable profile, default settings',
    async () => {
      const result = await http
        .post('/businesses')
        .send({ name: '  مخبز شروق  ', category: 'مخبز', phone: null })
        .expect(201);
      id = result.body.id;
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(result.body.name, 'مخبز شروق');
      assert.equal(result.body.category, 'مخبز');
      assert.equal(result.body.phone, null);
      assert.ok(result.body.createdAt);
      assert.equal(result.body.settings, undefined);
      const resultSettings = await http
        .get(`/businesses/${id}/settings`)
        .expect(200);
      assert.deepEqual(resultSettings.body, {
        businessId: id,
        acceptsCash: true,
        acceptsOnlinePayment: false,
        deliveryEnabled: false,
        pickupEnabled: true,
      });
    },
  );
  const invalidBodies = [
    {},
    { name: null },
    { name: '' },
    { name: '   ' },
    { name: 42 },
    { name: 'x'.repeat(201) },
    { name: 'Bakery', id: randomUUID() },
    { name: 'Bakery', description: 'x'.repeat(5001) },
    { name: 'Bakery', category: 'x'.repeat(201) },
    { name: 'Bakery', phone: 'x'.repeat(51) },
    { name: 'Bakery', address: 'x'.repeat(1001) },
    { name: 'Bakery', settings: {} },
  ];
  for (const [index, body] of invalidBodies.entries()) {
    await t.test(
      `Invalid request ${index + 1} is rejected before database write`,
      async () => {
        const previous = writes;
        const result = await http.post('/businesses').send(body).expect(400);
        assert.equal(result.body.code, 'VALIDATION_ERROR');
        assert.equal(writes, previous);
      },
    );
  }
  await t.test(
    'Existing profile and settings PATCH routes remain available',
    async () => {
      await http.get(`/businesses/${id}`).expect(200);
      const updated = await http
        .patch(`/businesses/${id}`)
        .send({ name: 'New Bakery' })
        .expect(200);
      assert.equal(updated.body.name, 'New Bakery');
      const updatedSettings = await http
        .patch(`/businesses/${id}/settings`)
        .send({ deliveryEnabled: true })
        .expect(200);
      assert.equal(updatedSettings.body.deliveryEnabled, true);
      await http.get(`/businesses/${id}/working-hours`).expect(200, []);
    },
  );
  await t.test(
    'Working hours PUT validation and unknown-business errors retain their contract',
    async () => {
      const invalid = await http
        .put(`/businesses/${id}/working-hours`)
        .send({ days: [] })
        .expect(400);
      assert.equal(invalid.body.code, 'VALIDATION_ERROR');
      const missing = await http.get(`/businesses/${randomUUID()}`).expect(404);
      assert.equal(missing.body.code, 'BUSINESS_NOT_FOUND');
    },
  );
});
