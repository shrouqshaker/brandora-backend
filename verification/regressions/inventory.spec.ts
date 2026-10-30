import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';

describe('Variant inventory transaction boundaries', () => {
  const scope = {
    businessId: 'business',
    catalogItemId: 'product',
    id: 'variant',
  };
  let service: InventoryService, tx: any, prisma: any;
  beforeEach(() => {
    tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'product', isActive: true }]),
      productVariant: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            stockQuantity: 10,
            trackInventory: true,
            isActive: true,
          }),
        update: jest.fn(),
      },
      inventoryMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(async ({ data }) => ({
            ...data,
            id: 'movement',
          })),
      },
    };
    prisma = {
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    service = new InventoryService(prisma as PrismaService);
  });
  it('locks the parent and writes only scoped variant inventory and its audit', async () => {
    const r = await service.setQuantity(scope, 15);
    expect(r).toEqual({
      changed: true,
      quantityBefore: 10,
      quantityAfter: 15,
      quantityDelta: 5,
      movementId: 'movement',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: scope,
      data: { stockQuantity: 15, trackInventory: true },
    });
    expect(tx.inventoryMovement.create.mock.calls[0][0].data).toMatchObject({
      businessId: 'business',
      catalogItemId: 'product',
      variantId: 'variant',
      trackingBefore: true,
      trackingAfter: true,
      quantityDelta: 5,
    });
  });
  it('does not create an unnecessary manual no-op movement', async () => {
    expect((await service.setQuantity(scope, 10)).changed).toBe(false);
    expect(tx.productVariant.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, NaN, Infinity, 2147483648, null, '10'])(
    'rejects invalid stock %s before opening transaction',
    async (value) => {
      await expect(
        service.setQuantity(scope, value as number),
      ).rejects.toMatchObject({ code: 'INVENTORY_QUANTITY_INVALID' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects order type through absolute stock setter', async () => {
    await expect(
      service.setQuantity(scope, 3, 'ORDER_APPROVED'),
    ).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_TYPE_INVALID' });
  });
  it.each([
    { type: '', id: 'x' },
    { type: 'x', id: ' ' },
    { type: 'x'.repeat(51), id: 'x' },
    { type: 'x', id: 'x'.repeat(201) },
  ])('rejects invalid references %j', async (reference) => {
    await expect(
      service.setQuantity(scope, 3, 'IMPORT_UPDATE', reference),
    ).rejects.toMatchObject({ code: 'INVENTORY_REFERENCE_INVALID' });
  });
  it('enables previously untracked stock with an audit', async () => {
    tx.productVariant.findFirst.mockResolvedValue({
      stockQuantity: null,
      trackInventory: false,
      isActive: true,
    });
    expect(await service.setQuantity(scope, 0)).toMatchObject({
      changed: true,
      quantityBefore: null,
      quantityAfter: 0,
      quantityDelta: 0,
    });
  });
  it('disables tracking explicitly and rejects discarded non-null stock', async () => {
    await expect(
      service.setQuantity(
        scope,
        4,
        'MANUAL_ADJUSTMENT',
        undefined,
        undefined,
        false,
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_QUANTITY_INVALID' });
    expect(
      await service.setQuantity(
        scope,
        null,
        'MANUAL_ADJUSTMENT',
        undefined,
        undefined,
        false,
      ),
    ).toMatchObject({ quantityBefore: 10, quantityAfter: null });
  });
  it('reuses a caller transaction without nesting', async () => {
    await service.setQuantity(
      scope,
      15,
      'IMPORT_UPDATE',
      undefined,
      tx as Prisma.TransactionClient,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('propagates failed audit creation for caller rollback', async () => {
    tx.inventoryMovement.create.mockRejectedValue(new Error('Audit failed'));
    await expect(service.setQuantity(scope, 15)).rejects.toThrow(
      'Audit failed',
    );
  });
  it.each(['parent', 'variant'])(
    'rejects inactive %s before stock writes',
    async (target) => {
      if (target === 'parent')
        tx.$queryRaw.mockResolvedValue([{ isActive: false }]);
      else tx.productVariant.findFirst.mockResolvedValue({ isActive: false });
      await expect(service.setQuantity(scope, 2)).rejects.toMatchObject({
        code: 'INVENTORY_INACTIVE',
      });
      expect(tx.productVariant.update).not.toHaveBeenCalled();
    },
  );
  it('does not use an unscoped or missing variant', async () => {
    tx.productVariant.findFirst.mockResolvedValue(null);
    await expect(service.setQuantity(scope, 2)).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
    });
  });
  it('idempotent import reference cannot reapply absolute stock after later writes', async () => {
    tx.inventoryMovement.findFirst.mockResolvedValue({
      id: 'prior',
      quantityBefore: 5,
      quantityAfter: 8,
      quantityDelta: 3,
      trackingAfter: true,
    });
    expect(
      await service.setQuantity(scope, 8, 'IMPORT_UPDATE', {
        type: 'IMPORT_ROW',
        id: 'row',
      }),
    ).toMatchObject({ changed: false, movementId: 'prior' });
    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });
  it('deduction uses current stock and refuses overselling', async () => {
    await expect(
      service.deductForOrder(tx, scope, 11, 'line'),
    ).rejects.toMatchObject({ code: 'INVENTORY_INSUFFICIENT_STOCK' });
    expect(await service.deductForOrder(tx, scope, 4, 'line')).toMatchObject({
      quantityAfter: 6,
      quantityDelta: -4,
    });
  });
  it('restoration requires its original order line and quantity', async () => {
    await expect(
      service.restoreForOrder(tx, scope, 2, 'line'),
    ).rejects.toMatchObject({ code: 'INVENTORY_CONFLICT' });
  });
  it('untracked orders still create a persistent idempotency audit', async () => {
    tx.productVariant.findFirst.mockResolvedValue({
      isActive: true,
      trackInventory: false,
      stockQuantity: null,
    });
    expect(await service.deductForOrder(tx, scope, 2, 'line')).toMatchObject({
      changed: false,
      quantityAfter: null,
      movementId: 'movement',
    });
    expect(
      tx.inventoryMovement.create.mock.calls[0][0].data.requestedQuantity,
    ).toBe(2);
  });
});
