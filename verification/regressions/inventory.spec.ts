import { ErrorCode } from '../../src/common/errors/error-code';
import { Test } from '@nestjs/testing';
import {
  InventoryMovementType,
  Prisma,
} from '../../src/generated/prisma/client';
import { InventoryModule } from '../../src/inventory/inventory.module';
import {
  InventoryReference,
  InventoryService,
} from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Inventory service (mocked Prisma transactions)', () => {
  let service: InventoryService;
  let committed: {
    quantity: number | null;
    movements: Record<string, unknown>[];
  };
  let draft: typeof committed;
  const item = { id: 'catalog-item-id', businessId: 'business-id' };
  const tx = {
    catalogItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryMovement: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    catalogItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryMovement: { create: jest.fn() },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [InventoryModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    service = module.get(InventoryService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    committed = { quantity: 10, movements: [] };
    draft = { quantity: 10, movements: [] };
    tx.catalogItem.findFirst.mockImplementation(async ({ where }) => {
      return where.id === item.id && where.businessId === item.businessId
        ? { stockQuantity: draft.quantity }
        : null;
    });
    tx.catalogItem.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.id !== item.id ||
        where.businessId !== item.businessId ||
        where.stockQuantity !== draft.quantity
      )
        return { count: 0 };
      draft.quantity = data.stockQuantity;
      return { count: 1 };
    });
    tx.inventoryMovement.create.mockImplementation(async ({ data }) => {
      draft.movements.push(data);
      return { id: 'movement-id' };
    });
    // Stage changes and commit only when the callback completes successfully.
    // This verifies service transaction control, not PostgreSQL itself.
    prisma.$transaction.mockImplementation(
      async (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        draft = {
          quantity: committed.quantity,
          movements: [...committed.movements],
        };
        const result = await callback(
          tx as unknown as Prisma.TransactionClient,
        );
        committed = {
          quantity: draft.quantity,
          movements: [...draft.movements],
        };
        return result;
      },
    );
  });

  afterEach(() => {
    expect(prisma.catalogItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.catalogItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('updates scoped stock and creates the audit record through one transaction', async () => {
    const result = await service.setQuantity(
      item,
      15,
      InventoryMovementType.IMPORT_UPDATE,
      { type: ' IMPORT_JOB ', id: ' import-id ' },
    );
    expect(result).toEqual({
      changed: true,
      quantityBefore: 10,
      quantityAfter: 15,
      quantityDelta: 5,
      movementId: 'movement-id',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.catalogItem.updateMany).toHaveBeenCalledWith({
      where: { ...item, stockQuantity: 10 },
      data: { stockQuantity: 15 },
    });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith({
      data: {
        businessId: item.businessId,
        catalogItemId: item.id,
        type: InventoryMovementType.IMPORT_UPDATE,
        quantityBefore: 10,
        quantityAfter: 15,
        quantityDelta: 5,
        referenceType: 'IMPORT_JOB',
        referenceId: 'import-id',
      },
      select: { id: true },
    });
    expect(committed.quantity).toBe(15);
    expect(committed.movements).toHaveLength(1);
  });

  it('records a negative delta when stock decreases to zero', async () => {
    const result = await service.setQuantity(
      item,
      0,
      InventoryMovementType.MANUAL_ADJUSTMENT,
    );
    expect(result.quantityDelta).toBe(-10);
    expect(committed.movements[0]).toMatchObject({
      quantityBefore: 10,
      quantityAfter: 0,
      quantityDelta: -10,
      referenceType: null,
      referenceId: null,
    });
  });

  it.each([0, 20])(
    'audits null stock initialization to %s while preserving the unknown prior value',
    async (quantity) => {
      committed.quantity = null;
      const result = await service.setQuantity(
        item,
        quantity,
        InventoryMovementType.INITIAL_IMPORT,
      );
      expect(result).toMatchObject({
        changed: true,
        quantityBefore: null,
        quantityAfter: quantity,
        quantityDelta: quantity,
      });
      expect(committed.movements[0]).toMatchObject({
        quantityBefore: null,
        quantityAfter: quantity,
        quantityDelta: quantity,
      });
    },
  );

  it('does not write stock or audit records when the quantity is unchanged', async () => {
    const result = await service.setQuantity(
      item,
      10,
      InventoryMovementType.IMPORT_UPDATE,
    );
    expect(result).toEqual({
      changed: false,
      quantityBefore: 10,
      quantityAfter: 10,
      quantityDelta: 0,
      movementId: null,
    });
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('ignores stale stock passed alongside the item identity', async () => {
    const stale = { ...item, stockQuantity: 100 };
    expect(
      (
        await service.setQuantity(
          stale,
          12,
          InventoryMovementType.IMPORT_UPDATE,
        )
      ).quantityBefore,
    ).toBe(10);
  });

  it.each(Object.values(InventoryMovementType))(
    'accepts movement type %s without implementing its caller workflow',
    async (type) => {
      await service.setQuantity(item, 12, type);
      expect(committed.movements[0].type).toBe(type);
    },
  );

  it.each([-1, 1.5, NaN, Infinity, 2147483648, null, '10'])(
    'rejects invalid target %s before opening a transaction',
    async (quantity) => {
      await expect(
        service.setQuantity(
          item,
          quantity as number,
          InventoryMovementType.IMPORT_UPDATE,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.INVENTORY_QUANTITY_INVALID });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts the PostgreSQL integer upper bound', async () => {
    const result = await service.setQuantity(
      item,
      2147483647,
      InventoryMovementType.INITIAL_IMPORT,
    );
    expect(result.quantityAfter).toBe(2147483647);
    expect(result.quantityDelta).toBe(2147483637);
  });

  it('rejects unknown movement types', async () => {
    await expect(
      service.setQuantity(item, 12, 'UNKNOWN' as InventoryMovementType),
    ).rejects.toMatchObject({
      code: ErrorCode.INVENTORY_MOVEMENT_TYPE_INVALID,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { type: '' },
    { type: 'x'.repeat(51) },
    { type: 'IMPORT_JOB', id: ' ' },
    { type: 'IMPORT_JOB', id: 'x'.repeat(201) },
  ])(
    'rejects invalid reference %j before a transaction',
    async (reference: InventoryReference) => {
      await expect(
        service.setQuantity(
          item,
          12,
          InventoryMovementType.IMPORT_UPDATE,
          reference,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.INVENTORY_REFERENCE_INVALID });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...item, businessId: 'wrong-business' },
    { ...item, id: 'missing-item' },
  ])('rejects inaccessible/missing catalog item %j', async (identity) => {
    await expect(
      service.setQuantity(identity, 12, InventoryMovementType.IMPORT_UPDATE),
    ).rejects.toMatchObject({ code: ErrorCode.CATALOG_ITEM_NOT_FOUND });
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('aborts when an intervening change prevents the conditional stock update', async () => {
    tx.catalogItem.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.setQuantity(item, 12, InventoryMovementType.IMPORT_UPDATE),
    ).rejects.toMatchObject({ code: ErrorCode.INVENTORY_CONFLICT });
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(committed.quantity).toBe(10);
  });

  it('does not commit stock when audit creation fails', async () => {
    tx.inventoryMovement.create.mockRejectedValue(
      new Error('Audit write failed'),
    );
    await expect(
      service.setQuantity(item, 12, InventoryMovementType.IMPORT_UPDATE),
    ).rejects.toThrow('Audit write failed');
    expect(tx.catalogItem.updateMany).toHaveBeenCalledTimes(1);
    expect(committed).toEqual({ quantity: 10, movements: [] });
  });

  it('does not create an audit when the stock write fails', async () => {
    tx.catalogItem.updateMany.mockRejectedValue(
      new Error('Stock write failed'),
    );
    await expect(
      service.setQuantity(item, 12, InventoryMovementType.IMPORT_UPDATE),
    ).rejects.toThrow('Stock write failed');
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(committed).toEqual({ quantity: 10, movements: [] });
  });

  it('reuses a caller transaction without nesting and lets the caller roll back failures', async () => {
    tx.inventoryMovement.create.mockRejectedValue(new Error('Audit failed'));
    await expect(
      prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
        return service.setQuantity(
          item,
          12,
          InventoryMovementType.IMPORT_UPDATE,
          undefined,
          transaction,
        );
      }),
    ).rejects.toThrow('Audit failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(committed).toEqual({ quantity: 10, movements: [] });
  });

  it('allows a caller transaction to commit the stock and audit together', async () => {
    await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
      return service.setQuantity(
        item,
        12,
        InventoryMovementType.IMPORT_UPDATE,
        undefined,
        transaction,
      );
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(committed.quantity).toBe(12);
    expect(committed.movements).toHaveLength(1);
  });
});
