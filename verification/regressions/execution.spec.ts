import { ExecutionService } from '../../src/imports/execution.service';
import { ImportPlanner } from '../../src/imports/preview/import-planner';
import { RowValidator } from '../../src/imports/validation/row-validator';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';

describe('Variant import execution lifecycle (group SQL exercised in PostgreSQL verifier)', () => {
  let service: ExecutionService,
    db: any,
    storage: any,
    excel: any,
    state: string;
  const mapping = ['externalKey', 'name', 'stockQuantity'].map((target, i) => ({
    sourceColumn: target,
    sourceColumnIndex: i + 1,
    type: 'STANDARD',
    target,
  }));
  beforeEach(() => {
    state = 'READY';
    db = {
      importJob: {
        findUnique: jest.fn().mockImplementation(async () => ({
          status: state,
          businessId: 'business',
          fileKey: 'file',
          sheetName: 'Products',
          headerRow: 1,
          mapping,
        })),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          if (state !== where.status) return { count: 0 };
          state = data.status;
          return { count: 1 };
        }),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      productVariant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    storage = { read: jest.fn().mockResolvedValue(Buffer.from('workbook')) };
    excel = {
      readDataRows: jest.fn().mockResolvedValue({
        headers: mapping.map((m) => m.sourceColumn),
        rows: [{ rowNumber: 2, isEmpty: false, values: ['A', 'Product', 4] }],
      }),
    };
    service = new ExecutionService(
      db,
      storage,
      excel,
      new RowValidator(new RowNormalizer()),
      new ImportPlanner(),
      {} as any,
    );
    jest.spyOn(service as any, 'executeGroup').mockResolvedValue([
      {
        action: 'INSERT',
        row: {
          rowNumber: 2,
          externalKey: 'A',
          productId: 'product',
          variantId: 'variant',
        },
      },
    ]);
  });
  it('claims READY atomically and reports real variant identities', async () => {
    expect(await service.execute('job')).toMatchObject({
      status: 'COMPLETED',
      summary: { insertedCount: 1 },
      inserted: [{ variantId: 'variant' }],
    });
    expect(db.importJob.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'job', status: 'READY' },
      data: { status: 'IMPORTING' },
    });
  });
  it.each([
    'UPLOADED',
    'MAPPING_REQUIRED',
    'IMPORTING',
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
  ])('does not re-execute %s jobs', async (status) => {
    state = status;
    await expect(service.execute('job')).rejects.toMatchObject({
      code: 'IMPORT_NOT_READY',
    });
    expect(db.importJob.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a lost concurrent execution claim', async () => {
    db.importJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.execute('job')).rejects.toMatchObject({
      code: 'IMPORT_EXECUTION_ALREADY_STARTED',
    });
  });
  it('reports missing jobs', async () => {
    db.importJob.findUnique.mockResolvedValue(null);
    await expect(service.execute('job')).rejects.toMatchObject({
      code: 'IMPORT_JOB_NOT_FOUND',
    });
  });
  it('rejects whole conflicting product groups and never calls the writer for them', async () => {
    excel.readDataRows.mockResolvedValue({
      headers: mapping.map((m) => m.sourceColumn),
      rows: [
        { rowNumber: 2, isEmpty: false, values: ['A', 'One', 4] },
        { rowNumber: 3, isEmpty: false, values: ['A', 'Two', 5] },
      ],
    });
    expect(await service.execute('job')).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: { invalidRows: 2, insertedCount: 0 },
    });
    expect((service as any).executeGroup).not.toHaveBeenCalled();
  });
  it('continues independent groups after a rolled back group error', async () => {
    excel.readDataRows.mockResolvedValue({
      headers: mapping.map((m) => m.sourceColumn),
      rows: [
        { rowNumber: 2, isEmpty: false, values: ['A', 'One', 4] },
        { rowNumber: 3, isEmpty: false, values: ['B', 'Two', 5] },
      ],
    });
    (service as any).executeGroup
      .mockRejectedValueOnce(new Error('private SQL'))
      .mockResolvedValueOnce([
        {
          action: 'INSERT',
          row: {
            rowNumber: 3,
            externalKey: 'B',
            productId: 'p',
            variantId: 'v',
          },
        },
      ]);
    const result = await service.execute('job');
    expect(result).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: { failedCount: 1, insertedCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private SQL');
  });
  it.each([
    ['file key', { fileKey: null }],
    ['empty file key', { fileKey: '' }],
    ['sheet name', { sheetName: null }],
    ['empty sheet name', { sheetName: '' }],
    ['header row', { headerRow: null }],
    ['claimed job', null],
  ])(
    'reports unavailable workbook for missing %s after claiming execution',
    async (_field, metadata) => {
      db.importJob.findUnique
        .mockResolvedValueOnce({ status: 'READY' })
        .mockResolvedValueOnce(
          metadata === null
            ? null
            : {
                businessId: 'business',
                fileKey: 'file',
                sheetName: 'Products',
                headerRow: 1,
                mapping,
                ...metadata,
              },
        );
      await expect(service.execute('job')).rejects.toMatchObject({
        code: 'IMPORT_WORKBOOK_UNAVAILABLE',
        status: 409,
        response: {
          code: 'IMPORT_WORKBOOK_UNAVAILABLE',
          message: 'The import job has no retained mapped workbook',
        },
      });
      expect(state).toBe('FAILED');
      expect(db.importJob.updateMany).toHaveBeenCalledTimes(2);
      expect(db.importJob.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'job', status: 'IMPORTING' },
        data: {
          status: 'FAILED',
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          skippedRows: 0,
          insertedCount: 0,
          updatedCount: 0,
          failedCount: 0,
          errors: {
            rows: [],
            execution: [],
            job: {
              code: 'EXECUTION_FAILED',
              message: 'Import execution could not be completed',
            },
          },
        },
      });
      expect(storage.read).not.toHaveBeenCalled();
      expect(excel.readDataRows).not.toHaveBeenCalled();
      expect((service as any).executeGroup).not.toHaveBeenCalled();
    },
  );
  it('preserves the workbook error if recording FAILED status also fails', async () => {
    db.importJob.findUnique
      .mockResolvedValueOnce({ status: 'READY' })
      .mockResolvedValueOnce({ fileKey: null });
    // The claim succeeds; only the subsequent failure recording is unavailable.
    db.importJob.updateMany
      .mockReset()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('private database error'));
    await expect(service.execute('job')).rejects.toMatchObject({
      code: 'IMPORT_WORKBOOK_UNAVAILABLE',
      status: 409,
    });
    expect(db.importJob.updateMany).toHaveBeenCalledTimes(2);
  });
  it('persists FAILED status and sanitizes unexpected workbook reading failures', async () => {
    storage.read.mockRejectedValue(new Error('private file path'));
    await expect(service.execute('job')).rejects.toMatchObject({
      code: 'IMPORT_EXECUTION_FAILED',
      status: 500,
      response: {
        code: 'IMPORT_EXECUTION_FAILED',
        message: 'Import execution could not be completed',
      },
    });
    expect(state).toBe('FAILED');
    expect(db.importJob.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'job', status: 'IMPORTING' },
      data: expect.objectContaining({
        status: 'FAILED',
        errors: {
          rows: [],
          execution: [],
          job: {
            code: 'EXECUTION_FAILED',
            message: 'Import execution could not be completed',
          },
        },
      }),
    });
    expect((service as any).executeGroup).not.toHaveBeenCalled();
  });
  it('retries only definitely aborted serializable transactions with a bounded new transaction', async () => {
    (service as any).executeGroup.mockRestore();
    db.$transaction = jest
      .fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockResolvedValueOnce([]);
    await (service as any).executeGroup('job', 'business', []);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction
      .mockReset()
      .mockRejectedValueOnce({ code: 'P2010', meta: { code: '40001' } })
      .mockResolvedValueOnce([]);
    await (service as any).executeGroup('job', 'business', []);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockReset().mockRejectedValue({ code: 'P2034' });
    await expect(
      (service as any).executeGroup('job', 'business', []),
    ).rejects.toEqual({ code: 'P2034' });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    db.$transaction.mockReset().mockRejectedValue({ code: 'ECONNRESET' });
    await expect(
      (service as any).executeGroup('job', 'business', []),
    ).rejects.toEqual({ code: 'ECONNRESET' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
