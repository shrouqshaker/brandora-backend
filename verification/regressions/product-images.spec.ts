import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CloudinaryService,
  imageFile,
  MAX_IMAGE_BYTES,
} from '../../src/products/images/cloudinary.service';
import { ProductImagesService } from '../../src/products/images/product-images.service';
import { ProductAccessService } from '../../src/products/product-access.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AppHttpException } from '../../src/common/errors/app-http.exception';
import { ErrorCode } from '../../src/common/errors/error-code';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { ProductImagesController } from '../../src/products/images/product-images.controller';
import { AuthGuard } from '../../src/auth/auth.guard';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';

const file = (
  buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  mimetype = 'image/jpeg',
) => ({ buffer, mimetype }) as Express.Multer.File;
const settings = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: '123456',
  CLOUDINARY_API_SECRET: 'fixture-secret',
};
const publicId = 'brandora/products/business/product/test';
const metadata = {
  public_id: publicId,
  resource_type: 'image',
  secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/test.jpg',
  width: 40,
  height: 30,
  bytes: 100,
  format: 'jpg',
};
const asset = {
  secureUrl: metadata.secure_url,
  width: 40,
  height: 30,
  bytes: 100,
  format: 'jpg',
};

describe('Cloudinary signed HTTPS transport (no network)', () => {
  const cloud = (overrides = {}) =>
    new CloudinaryService(new ConfigService({ ...settings, ...overrides }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('signs only server-selected parameters and validates HTTPS image metadata', async () => {
    const request = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(metadata)));
    expect(await cloud().upload(publicId, imageFile(file()))).toEqual(asset);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/upload');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const form = init!.body as FormData;
    const signed = `allowed_formats=jpg,png,webp&overwrite=false&public_id=${publicId}&timestamp=${form.get('timestamp')}`;
    expect(form.get('signature')).toBe(
      createHash('sha256')
        .update(signed + settings.CLOUDINARY_API_SECRET)
        .digest('hex'),
    );
    expect(form.has('api_secret')).toBe(false);
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it.each([
    { CLOUDINARY_CLOUD_NAME: '' },
    { CLOUDINARY_CLOUD_NAME: '../host' },
    { CLOUDINARY_API_KEY: '' },
    { CLOUDINARY_API_SECRET: '' },
  ])('fails closed for configuration %j', async (overrides) => {
    const request = jest.spyOn(globalThis, 'fetch');
    expect(() => cloud(overrides).assertReady()).toThrow('not configured');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { secure_url: 'http://res.cloudinary.com/test-cloud/image/upload/test' },
    { secure_url: 'https://attacker.invalid/image' },
    { public_id: 'other' },
    { resource_type: 'raw' },
    { width: 0 },
    { width: 100000, height: 100000 },
    { format: 'svg' },
    { bytes: MAX_IMAGE_BYTES + 1 },
  ])('rejects invalid provider metadata %j', async (overrides) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ...metadata, ...overrides })),
      );
    await expect(
      cloud().upload(publicId, imageFile(file())),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_UNAVAILABLE' });
  });

  it('sanitizes provider errors without reading their body', async () => {
    const json = jest.fn();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, json } as unknown as Response);
    await expect(cloud().upload(publicId, imageFile(file()))).rejects.toThrow(
      'Image storage request failed',
    );
    expect(json).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'])(
    'aborts slow %s after 30 seconds',
    async (phase) => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const signal = init!.signal!;
        if (phase === 'headers')
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () =>
              reject(new Error('private provider request')),
            ),
          );
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener('abort', () =>
                  controller.error(new Error('private body')),
                );
              },
            }),
          ),
        );
      });
      const sent = cloud().upload(publicId, imageFile(file()));
      const rejected = expect(sent).rejects.toThrow(
        'Image storage request failed',
      );
      await jest.advanceTimersByTimeAsync(29999);
      await jest.advanceTimersByTimeAsync(1);
      await rejected;
    },
  );

  it.each(['ok', 'not found'])(
    'accepts idempotent destruction result %s',
    async (result) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ result })));
      await expect(cloud().destroy(publicId)).resolves.toBe(result);
    },
  );
});

// Serialized transactions emulate the existing scoped parent lock. These are
// application concurrency tests, not a claim that PostgreSQL SQL was executed.
function fixture() {
  const rows: any[] = [];
  const parent = { options: {}, colorOptionName: null };
  const matches = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) =>
      v !== null && typeof v === 'object'
        ? (v as any).in.includes(r[k])
        : r[k] === v,
    );
  const validate = () => {
    const active = rows.filter((r) => r.status === 'ACTIVE');
    if (
      active.some((r) => r.position < 0 || r.position > 4) ||
      new Set(active.map((r) => r.position)).size !== active.length
    )
      throw Error('slot uniqueness');
  };
  const image = {
    create: jest.fn(async ({ data }) => {
      const row = {
        position: 0,
        optionName: null,
        optionValue: null,
        status: 'UPLOADING',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    }),
    findMany: jest.fn(async ({ where }) =>
      rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) =>
            a.position - b.position ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id),
        ),
    ),
    findFirst: jest.fn(
      async ({ where }) => rows.find((r) => matches(r, where)) ?? null,
    ),
    updateMany: jest.fn(async ({ where, data }) => {
      const selected = rows.filter((r) => matches(r, where));
      selected.forEach((r) => Object.assign(r, data));
      validate();
      return { count: selected.length };
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw Error('not found');
      Object.assign(row, data);
      validate();
      return row;
    }),
    delete: jest.fn(async ({ where }) => {
      const i = rows.findIndex((r) => matches(r, where));
      if (i < 0) throw Error('not found');
      return rows.splice(i, 1)[0];
    }),
  };
  const tx = { productImage: image };
  let tail = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: jest.fn((work: any) => {
      const run = tail.then(async () => {
        const before = structuredClone(rows);
        try {
          return await work(tx);
        } catch (e) {
          rows.splice(0, rows.length, ...before);
          throw e;
        }
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const access = {
    lock: jest.fn(async (b: string, p: string) => {
      if (b !== businessId || p !== productId)
        throw new AppHttpException(
          ErrorCode.PRODUCT_NOT_FOUND,
          404,
          'Product not found',
        );
      return parent;
    }),
    product: jest.fn(async (b: string, p: string) => {
      if (b !== businessId || p !== productId)
        throw new AppHttpException(
          ErrorCode.PRODUCT_NOT_FOUND,
          404,
          'Product not found',
        );
      return parent;
    }),
  };
  const cloud = {
    assertReady: jest.fn(),
    upload: jest.fn().mockResolvedValue(asset),
    destroy: jest.fn().mockResolvedValue('ok'),
  };
  const service = new ProductImagesService(
    prisma as unknown as PrismaService,
    access as unknown as ProductAccessService,
    cloud as unknown as CloudinaryService,
  );
  return { rows, image, parent, cloud, service, prisma, tx };
}
const businessId = '10000000-0000-4000-8000-000000000001',
  productId = '20000000-0000-4000-8000-000000000001';
const foreignId = '90000000-0000-4000-8000-000000000001';
describe('Product image HTTP contract with real owner guard and mocked persistence/provider', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fixture>;
  let owner: string;
  const url = `/businesses/${businessId}/products/${productId}/images`;
  beforeEach(async () => {
    f = fixture();
    const id = '30000000-0000-4000-8000-000000000001';
    const jwt = new JwtService({
      secret: 'synthetic-image-http-secret-with-enough-length',
    });
    owner = await jwt.signAsync(
      { sub: id, sid: id, ver: 0 },
      { expiresIn: '5m' },
    );
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id, authVersion: 0 }) },
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          userId: id,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
      businessMember: {
        findUnique: jest.fn(async ({ where }) =>
          where.userId_businessId.businessId === businessId
            ? { isActive: true, role: 'OWNER' }
            : null,
        ),
      },
    };
    const module = await Test.createTestingModule({
      controllers: [ProductImagesController],
      providers: [{ provide: ProductImagesService, useValue: f.service }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalGuards(
      new AuthGuard(new Reflector(), jwt, prisma as unknown as PrismaService),
    );
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
  afterEach(async () => {
    await app.close();
  });
  it('accepts exactly five files over multipart and rejects a sixth request', async () => {
    let req = request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner}`);
    for (let i = 0; i < 5; i++)
      req = req.attach('files', file().buffer, {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });
    const response = await req.expect(201);
    expect(response.body.items).toHaveLength(5);
    await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner}`)
      .attach('file', file().buffer, {
        filename: 'six.jpg',
        contentType: 'image/jpeg',
      })
      .expect(400);
    expect(f.cloud.upload).toHaveBeenCalledTimes(5);
  });
  it('requires an authenticated owner and hides another Business', async () => {
    await request(app.getHttpServer()).get(url).expect(401);
    await request(app.getHttpServer())
      .get(url.replace(businessId, foreignId))
      .set('Authorization', `Bearer ${owner}`)
      .expect(404);
    expect(f.cloud.upload).not.toHaveBeenCalled();
  });
  it('supports single file, batch files, explicit Main, ordering and deletion', async () => {
    const single = await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner}`)
      .attach('file', file().buffer, {
        filename: 'one.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(single.body).toMatchObject({ position: 0, isMain: true });
    const batch = await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner}`)
      .attach('files', file().buffer, {
        filename: 'two.jpg',
        contentType: 'image/jpeg',
      })
      .attach('files', file().buffer, {
        filename: 'three.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(batch.body.items.map((i: any) => i.position)).toEqual([1, 2]);
    const ids = [single.body.id, ...batch.body.items.map((i: any) => i.id)];
    await request(app.getHttpServer())
      .patch(`${url}/${ids[2]}`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ isMain: true })
      .expect(200);
    await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${owner}`)
      .send({ imageIds: [ids[2], ids[1], ids[0]] })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`${url}/${ids[2]}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    const remaining = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(remaining.body.items[0]).toMatchObject({
      id: ids[1],
      position: 0,
      isMain: true,
    });
  });
  it.each(['attributes', 'mixed', 'six'])(
    'rejects %s multipart before Cloudinary',
    async (kind) => {
      let req = request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${owner}`);
      if (kind === 'attributes') req = req.field('optionName', 'Color');
      if (kind === 'mixed')
        req = req.attach('file', file().buffer, {
          filename: 'one.jpg',
          contentType: 'image/jpeg',
        });
      for (let i = 0; i < (kind === 'six' ? 6 : 1); i++)
        req = req.attach('files', file().buffer, {
          filename: 'image.jpg',
          contentType: 'image/jpeg',
        });
      expect((await req).status).toBe(400);
      expect(f.cloud.upload).not.toHaveBeenCalled();
      expect(f.rows).toEqual([]);
    },
  );
  it.each([
    { isMain: false },
    { isMain: 'true' },
    { isMain: true, businessId: foreignId },
  ])('rejects invalid Main input %#', async (body) => {
    await request(app.getHttpServer())
      .patch(`${url}/${foreignId}`)
      .set('Authorization', `Bearer ${owner}`)
      .send(body)
      .expect(400);
  });
});
const upload = (f: ReturnType<typeof fixture>) =>
  f.service.upload(businessId, productId, {}, file());
const list = (f: ReturnType<typeof fixture>) =>
  f.service.list(businessId, productId);

describe('Product Main/Gallery policy and compensating cleanup (no database/network)', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());
  it.each([
    undefined,
    file(Buffer.from('<svg/>'), 'image/svg+xml'),
    file(Buffer.from([0xff, 0xd8, 0xff]), 'image/png'),
  ])('rejects missing/spoofed file %#', (value) =>
    expect(() => imageFile(value)).toThrow(),
  );
  it('keeps the 5 MiB limit', () =>
    expect(() => imageFile(file(Buffer.alloc(MAX_IMAGE_BYTES + 1)))).toThrow(
      '5 MB',
    ));
  it('makes the first upload Main without options or Variants, and appends galleries', async () => {
    const f = fixture();
    const first = await upload(f);
    const second = await upload(f);
    expect(first).toMatchObject({ isMain: true, position: 0 });
    expect(second).toMatchObject({ isMain: false, position: 1 });
    expect((await list(f)).items.map((i) => i.id)).toEqual([
      first!.id,
      second!.id,
    ]);
    expect(f.cloud.destroy).not.toHaveBeenCalled();
    expect(f.parent).toEqual({ options: {}, colorOptionName: null });
  });
  it('accepts five total images and rejects a sixth before Cloudinary', async () => {
    const f = fixture();
    const result = await f.service.uploadBatch(
      businessId,
      productId,
      {},
      Array.from({ length: 5 }, () => file()),
    );
    expect(result!.items).toHaveLength(5);
    expect(result!.items.filter((i) => i.isMain)).toHaveLength(1);
    await expect(upload(f)).rejects.toMatchObject({
      code: 'PRODUCT_IMAGE_INVALID',
    });
    expect(f.cloud.upload).toHaveBeenCalledTimes(5);
  });
  it('rejects an oversized batch atomically without reservations/provider requests', async () => {
    const f = fixture();
    await f.service.uploadBatch(
      businessId,
      productId,
      {},
      Array.from({ length: 4 }, () => file()),
    );
    const ids = f.rows.map((r) => r.id);
    await expect(
      f.service.uploadBatch(businessId, productId, {}, [file(), file()]),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' });
    expect(f.rows.map((r) => r.id)).toEqual(ids);
    expect(f.cloud.upload).toHaveBeenCalledTimes(4);
  });
  it('validates every batch member and rejects legacy associations before side effects', async () => {
    const f = fixture();
    await expect(
      f.service.uploadBatch(businessId, productId, {}, [
        file(),
        file(Buffer.from('bad')),
      ]),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' });
    await expect(
      f.service.upload(
        businessId,
        productId,
        { optionName: 'Size', optionValue: 'L' },
        file(),
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' });
    expect(f.rows).toEqual([]);
    expect(f.cloud.upload).not.toHaveBeenCalled();
  });
  it('switches Main explicitly and keeps one Main while ordering the gallery', async () => {
    const f = fixture();
    const r = await f.service.uploadBatch(businessId, productId, {}, [
      file(),
      file(),
      file(),
    ]);
    const ids = r!.items.map((i) => i.id);
    expect(
      (await f.service.setMain(businessId, productId, ids[2]))!.items.map(
        (i) => i.id,
      ),
    ).toEqual([ids[2], ids[0], ids[1]]);
    const ordered = await f.service.reorder(businessId, productId, [
      ids[2],
      ids[1],
      ids[0],
    ]);
    expect(ordered!.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(ordered!.items.filter((i) => i.isMain).map((i) => i.id)).toEqual([
      ids[2],
    ]);
    expect(f.cloud.destroy).not.toHaveBeenCalled();
  });
  it('promotes first remaining in saved order on Main deletion and ends with no Main', async () => {
    const f = fixture();
    const r = await f.service.uploadBatch(businessId, productId, {}, [
      file(),
      file(),
      file(),
    ]);
    const ids = r!.items.map((i) => i.id);
    await f.service.reorder(businessId, productId, [ids[0], ids[2], ids[1]]);
    await f.service.remove(businessId, productId, ids[0]);
    expect((await list(f)).items[0]).toMatchObject({
      id: ids[2],
      position: 0,
      isMain: true,
    });
    await f.service.remove(businessId, productId, ids[2]);
    await f.service.remove(businessId, productId, ids[1]);
    expect((await list(f)).items).toEqual([]);
    expect((await upload(f))!.isMain).toBe(true);
  });
  it('rejects foreign business/product/image IDs without deleting assets', async () => {
    const f = fixture();
    const r = await upload(f);
    await expect(
      f.service.setMain(foreignId, productId, r!.id),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    await expect(
      f.service.remove(businessId, foreignId, r!.id),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    await expect(
      f.service.reorder(businessId, productId, [foreignId]),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_NOT_FOUND' });
    expect(f.cloud.destroy).not.toHaveBeenCalled();
  });
  it('rejects incomplete, repeated and non-active ordering IDs', async () => {
    const f = fixture();
    const r = await f.service.uploadBatch(businessId, productId, {}, [
      file(),
      file(),
    ]);
    const ids = r!.items.map((i) => i.id);
    await expect(
      f.service.reorder(businessId, productId, [ids[0]]),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' });
    await expect(
      f.service.reorder(businessId, productId, [ids[0], ids[0]]),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' });
    await expect(
      f.service.setMain(businessId, productId, foreignId),
    ).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_NOT_FOUND' });
  });
  it('reserves pending slots before HTTPS so concurrent instances cannot exceed five', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    f.cloud.upload.mockImplementation(async () => {
      await barrier;
      return asset;
    });
    const second = new ProductImagesService(
      f.prisma as unknown as PrismaService,
      { lock: async () => ({}) } as unknown as ProductAccessService,
      f.cloud as unknown as CloudinaryService,
    );
    const promises = Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? second : f.service)
        .upload(businessId, productId, {}, file())
        .then(
          (value) => ({ ok: true, value }),
          () => ({ ok: false, value: null }),
        ),
    );
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(
      f.rows.filter((r) => r.status === 'UPLOADING').length,
    ).toBeLessThanOrEqual(5);
    release();
    const results = await Promise.all(promises);
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(f.cloud.upload).toHaveBeenCalledTimes(5);
    expect((await list(f)).items.filter((i) => i.isMain)).toHaveLength(1);
  });
  it('serializes simultaneous Main changes and deletion without duplicate Main slots', async () => {
    const f = fixture();
    const r = await f.service.uploadBatch(businessId, productId, {}, [
      file(),
      file(),
      file(),
    ]);
    const ids = r!.items.map((i) => i.id);
    await Promise.all([
      f.service.setMain(businessId, productId, ids[1]),
      f.service.setMain(businessId, productId, ids[2]),
      f.service.remove(businessId, productId, ids[0]),
    ]);
    const active = (await list(f)).items;
    expect(active).toHaveLength(2);
    expect(active.filter((i) => i.isMain)).toHaveLength(1);
    expect(active.map((i) => i.position)).toEqual([0, 1]);
  });
  it('compensates whole batch on provider failure without replacing the existing Main', async () => {
    const f = fixture();
    const first = await upload(f);
    f.cloud.upload
      .mockResolvedValueOnce(asset)
      .mockRejectedValueOnce(Error('controlled upload failure'));
    await expect(
      f.service.uploadBatch(businessId, productId, {}, [file(), file()]),
    ).rejects.toThrow('controlled upload failure');
    expect((await list(f)).items.map((i) => i.id)).toEqual([first!.id]);
    expect(f.cloud.destroy).toHaveBeenCalledTimes(2);
  });
  it('awaits a slower sibling upload before compensating a failed batch', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.cloud.upload
      .mockRejectedValueOnce(Error('controlled failure'))
      .mockImplementationOnce(async () => {
        await barrier;
        return asset;
      });
    const result = f.service
      .uploadBatch(businessId, productId, {}, [file(), file()])
      .then(
        () => null,
        (error) => error,
      );
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.cloud.destroy).not.toHaveBeenCalled();
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(f.cloud.destroy).toHaveBeenCalledTimes(2);
    expect(f.rows).toEqual([]);
  });
  it('rolls back a failed Main swap without losing old order or destroying assets', async () => {
    const f = fixture();
    const r = await f.service.uploadBatch(businessId, productId, {}, [
      file(),
      file(),
    ]);
    const ids = r!.items.map((i) => i.id);
    f.image.update.mockRejectedValueOnce(Error('write failed'));
    await expect(
      f.service.setMain(businessId, productId, ids[1]),
    ).rejects.toThrow('write failed');
    expect((await list(f)).items.map((i) => i.id)).toEqual(ids);
    expect((await list(f)).items.filter((i) => i.isMain)).toHaveLength(1);
    expect(f.cloud.destroy).not.toHaveBeenCalled();
  });
  it('rolls back activation failure and cleans only new reserved assets', async () => {
    const f = fixture();
    const first = await upload(f);
    f.image.update.mockRejectedValueOnce(Error('activation failed'));
    await expect(upload(f)).rejects.toThrow('activation failed');
    expect((await list(f)).items.map((i) => i.id)).toEqual([first!.id]);
    expect(f.cloud.destroy).toHaveBeenCalledTimes(1);
  });
  it('does not destroy possibly committed ACTIVE assets after ambiguous COMMIT', async () => {
    const f = fixture();
    f.prisma.$transaction
      .mockImplementationOnce(async (work) => work(f.tx))
      .mockImplementationOnce(async (work) => {
        await work(f.tx);
        throw Error('commit unknown');
      });
    await expect(upload(f)).rejects.toThrow('commit unknown');
    expect(f.rows[0]).toMatchObject({ status: 'ACTIVE', position: 0 });
    expect(f.cloud.destroy).not.toHaveBeenCalled();
  });
  it('never destroys assets when database deletion fails', async () => {
    const f = fixture();
    const first = await upload(f);
    f.image.update.mockRejectedValueOnce(Error('database unavailable'));
    await expect(
      f.service.remove(businessId, productId, first!.id),
    ).rejects.toThrow();
    expect(f.cloud.destroy).not.toHaveBeenCalled();
    expect((await list(f)).items[0].isMain).toBe(true);
  });
  it('preserves active/UPLOADING metadata if activation and compensation persistence fail', async () => {
    const f = fixture();
    const first = await upload(f);
    f.image.update.mockRejectedValueOnce(Error('activation failed'));
    f.image.updateMany.mockRejectedValueOnce(Error('invalidation failed'));
    await expect(upload(f)).rejects.toThrow('activation failed');
    expect(f.rows.find((r) => r.id === first!.id).status).toBe('ACTIVE');
    expect(f.rows.some((r) => r.status === 'UPLOADING')).toBe(true);
    expect(f.cloud.destroy).not.toHaveBeenCalled();
  });
  it('promotes safely despite failed cloud deletion and supports explicit cleanup retry', async () => {
    const f = fixture();
    const first = await upload(f);
    const second = await upload(f);
    f.cloud.destroy.mockRejectedValueOnce(Error('provider unavailable'));
    expect(await f.service.remove(businessId, productId, first!.id)).toEqual({
      deleted: true,
      cleanupPending: true,
    });
    expect((await list(f)).items[0]).toMatchObject({
      id: second!.id,
      isMain: true,
    });
    expect(await f.service.remove(businessId, productId, first!.id)).toEqual({
      deleted: true,
      cleanupPending: false,
    });
  });
  it('keeps a timed-out public ID when remote deletion cannot yet find it', async () => {
    const f = fixture();
    f.cloud.upload.mockRejectedValueOnce(Error('deadline'));
    f.cloud.destroy.mockResolvedValueOnce('not found');
    await expect(upload(f)).rejects.toThrow();
    expect(f.rows[0]).toMatchObject({ status: 'DELETE_PENDING' });
    expect(f.rows[0].publicId).toContain(f.rows[0].id);
  });
});
