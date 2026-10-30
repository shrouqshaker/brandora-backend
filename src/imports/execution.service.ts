import {
  HttpStatus,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import {
  ImportJobStatus,
  InventoryMovementType,
  Prisma,
} from '../generated/prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportPlanner } from './preview/import-planner';
import { ImportFileStorage } from './storage/import-file.storage';
import { RowValidator } from './validation/row-validator';
import { RowValidationResult } from './validation/row.types';
import { parseSavedMapping } from './validation/saved-mapping';
import {
  checkImportDatabase,
  prepareImportContext,
  ensureImportCategory,
  importCategoryName,
  mergedImportAttributes,
  mergedOptions,
  selectedOptions,
} from './variant-import-policy';

type ValidRow = RowValidationResult['validRows'][number];
export interface ExecutedRow {
  rowNumber: number;
  externalKey: string | null;
  catalogItemId: string;
  variantId: string;
}
export interface FailedRow {
  rowNumber: number;
  code: string;
  message: string;
}

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportFileStorage,
    private readonly excel: ExcelAdapter,
    private readonly rows: RowValidator,
    private readonly planner: ImportPlanner,
    private readonly inventory: InventoryService,
  ) {}

  async execute(importId: string) {
    const initial = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { status: true },
    });
    if (!initial)
      throw new AppHttpException(
        ErrorCode.IMPORT_JOB_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Import job not found',
      );
    if (initial.status !== ImportJobStatus.READY)
      throw new AppHttpException(
        ErrorCode.IMPORT_NOT_READY,
        HttpStatus.CONFLICT,
        'The import job must be READY before execution',
      );
    const claim = await this.prisma.importJob.updateMany({
      where: { id: importId, status: ImportJobStatus.READY },
      data: { status: ImportJobStatus.IMPORTING },
    });
    if (claim.count !== 1)
      throw new AppHttpException(
        ErrorCode.IMPORT_EXECUTION_ALREADY_STARTED,
        HttpStatus.CONFLICT,
        'Execution has already started or status changed',
      );
    const inserted: ExecutedRow[] = [],
      updated: ExecutedRow[] = [],
      unchanged: ExecutedRow[] = [],
      failedRows: FailedRow[] = [];
    let validated: RowValidationResult | undefined;
    const counters = () => ({
      ...(validated?.summary ?? {
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        skippedRows: 0,
      }),
      insertedCount: inserted.length,
      updatedCount: updated.length,
      failedCount: failedRows.length,
    });
    const errors = () => ({
      rows: (validated?.invalidRows ?? []).map((r) => ({
        rowNumber: r.rowNumber,
        errors: r.errors.map((e) => ({ ...e })),
      })),
      execution: failedRows.map((r) => ({ ...r })),
    });
    try {
      const job = await this.prisma.importJob.findUnique({
        where: { id: importId },
        select: {
          businessId: true,
          fileKey: true,
          sheetName: true,
          headerRow: true,
          mapping: true,
        },
      });
      if (!job?.fileKey || !job.sheetName || job.headerRow === null)
        throw new Error('Missing workbook metadata');
      const workbook = await this.excel.readDataRows(
        await this.storage.read(job.fileKey),
        job.sheetName,
        job.headerRow,
      );
      validated = await checkImportDatabase(
        this.rows.validate(
          workbook.rows,
          parseSavedMapping(job.mapping, workbook.headers),
        ),
        job.businessId,
        this.prisma,
      );
      const groups = new Map<string, ValidRow[]>();
      for (const row of validated.validRows) {
        const key = row.data.externalKey!;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        try {
          for (const result of await this.executeGroup(
            importId,
            job.businessId,
            group,
          )) {
            if (result.action === 'INSERT') inserted.push(result.row);
            else if (result.action === 'UPDATE') updated.push(result.row);
            else unchanged.push(result.row);
          }
        } catch (error: unknown) {
          const code = (error as { code?: string })?.code;
          if (
            code &&
            [
              'P1001',
              'P1002',
              'P1008',
              'P1017',
              'P2024',
              'ECONNREFUSED',
              'ECONNRESET',
            ].includes(code)
          )
            throw error;
          const conflict =
            error instanceof ConflictException ||
            (error instanceof AppHttpException &&
              error.getStatus() === HttpStatus.CONFLICT) ||
            code === 'P2002' ||
            code === 'P2034';
          for (const row of group)
            failedRows.push({
              rowNumber: row.rowNumber,
              code: conflict ? 'EXECUTION_CONFLICT' : 'ROW_EXECUTION_FAILED',
              message: conflict
                ? 'Product group conflicts with current data; no row in this group was applied'
                : 'Product group could not be applied; its transaction was rolled back',
            });
        }
      }
      const status =
        validated.invalidRows.length || failedRows.length
          ? ImportJobStatus.COMPLETED_WITH_ERRORS
          : ImportJobStatus.COMPLETED;
      const complete = await this.prisma.importJob.updateMany({
        where: { id: importId, status: ImportJobStatus.IMPORTING },
        data: { status, ...counters(), errors: errors() },
      });
      if (complete.count !== 1) throw new Error('Lifecycle changed');
      return {
        importId,
        status,
        summary: { ...counters(), unchangedCount: unchanged.length },
        inserted,
        updated,
        unchanged,
        failedRows,
        invalidRows: validated.invalidRows,
      };
    } catch {
      this.logger.error(
        'Import execution failed; inspect job counters and sanitized row errors',
      );
      try {
        await this.prisma.importJob.updateMany({
          where: { id: importId, status: ImportJobStatus.IMPORTING },
          data: {
            status: ImportJobStatus.FAILED,
            ...counters(),
            errors: {
              ...errors(),
              job: {
                code: 'EXECUTION_FAILED',
                message: 'Import execution could not be completed',
              },
            },
          },
        });
      } catch {
        this.logger.error('Unable to persist failed execution status');
      }
      throw new AppHttpException(
        ErrorCode.IMPORT_EXECUTION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Import execution could not be completed',
      );
    }
  }

  private async executeGroup(
    importId: string,
    businessId: string,
    group: ValidRow[],
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const externalKey = group[0].data.externalKey!;
            // Serializes first insertion too, when there is no parent row yet.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${businessId + ':' + externalKey}, 0))::text`;
            await tx.$queryRaw`SELECT id FROM "CatalogItem" WHERE "businessId"=${businessId}::uuid AND "externalKey"=${externalKey} FOR UPDATE`;
            const context = await prepareImportContext(
              {
                summary: {
                  totalRows: group.length,
                  validRows: group.length,
                  invalidRows: 0,
                  skippedRows: 0,
                },
                validRows: group,
                invalidRows: [],
              },
              businessId,
              tx,
            );
            if (context.validation.invalidRows.length)
              throw new ConflictException(
                'Import group conflicts with current product data',
              );
            const existing = context.products.find(
              (product) => product.externalKey === externalKey,
            );
            const plan = this.planner.plan(
              businessId,
              group,
              existing ? [existing] : [],
              context.categories,
            );
            const first = group[0].data;
            const options = mergedOptions(
              first.options ?? {},
              existing?.options,
            );
            const productData: Prisma.CatalogItemUncheckedUpdateInput = {
              options,
            };
            for (const field of [
              'name',
              'description',
              'category',
              'basePrice',
            ] as const)
              if (first[field] != null) productData[field] = first[field];
            productData.attributes = mergedImportAttributes(
              first,
              existing?.attributes,
            );
            if (first.category) {
              const name = importCategoryName(first.category);
              productData.categoryId = await ensureImportCategory(
                context.categories.get(name)!,
                businessId,
                tx,
              );
            }
            if (existing) {
              const changes = this.planner.productChanges(
                first,
                existing,
                context.categories,
              );
              for (const key of Object.keys(productData))
                if (!(key in changes))
                  delete (productData as Record<string, unknown>)[key];
            }
            const product = existing
              ? Object.keys(productData).length
                ? await tx.catalogItem.update({
                    where: { id: existing.id, businessId },
                    data: productData,
                  })
                : existing
              : await tx.catalogItem.create({
                  data: {
                    ...productData,
                    businessId,
                    externalKey,
                    name: first.name!,
                  } as Prisma.CatalogItemUncheckedCreateInput,
                });
            const results: {
              action: 'INSERT' | 'UPDATE' | 'UNCHANGED';
              row: ExecutedRow;
            }[] = [];
            for (const row of group) {
              const optionValues = selectedOptions(row.data);
              const prior = await tx.productVariant.findUnique({
                where: {
                  businessId_catalogItemId_optionValues: {
                    businessId,
                    catalogItemId: product.id,
                    optionValues,
                  },
                },
              });
              const variantData = {
                ...(row.data.sku != null && row.data.sku !== prior?.sku
                  ? { sku: row.data.sku }
                  : {}),
                ...(row.data.unitPrice != null &&
                row.data.unitPrice !== prior?.unitPrice?.toFixed(2)
                  ? { unitPrice: new Prisma.Decimal(row.data.unitPrice) }
                  : {}),
              };
              const variant = prior
                ? Object.keys(variantData).length
                  ? await tx.productVariant.update({
                      where: {
                        id: prior.id,
                        businessId,
                        catalogItemId: product.id,
                      },
                      data: variantData,
                    })
                  : prior
                : await tx.productVariant.create({
                    data: {
                      businessId,
                      catalogItemId: product.id,
                      optionValues,
                      ...variantData,
                    },
                  });
              if (row.data.stockQuantity != null)
                await this.inventory.setQuantity(
                  { id: variant.id, businessId, catalogItemId: product.id },
                  row.data.stockQuantity,
                  prior
                    ? InventoryMovementType.IMPORT_UPDATE
                    : InventoryMovementType.INITIAL_IMPORT,
                  { type: 'IMPORT_ROW', id: importId + ':' + row.rowNumber },
                  tx,
                );
              const action = !prior
                ? 'INSERT'
                : plan.updates.some((r) => r.rowNumber === row.rowNumber)
                  ? 'UPDATE'
                  : 'UNCHANGED';
              results.push({
                action,
                row: {
                  rowNumber: row.rowNumber,
                  externalKey,
                  catalogItemId: product.id,
                  variantId: variant.id,
                },
              });
            }
            return results;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 30000,
          },
        );
      } catch (error) {
        const failure = error as {
          code?: string;
          meta?: {
            code?: string;
            driverAdapterError?: { cause?: { originalCode?: string } };
          };
        };
        const aborted =
          failure?.code === 'P2034' ||
          (failure?.code === 'P2010' &&
            (failure.meta?.code ??
              failure.meta?.driverAdapterError?.cause?.originalCode) ===
              '40001');
        if (!aborted || attempt >= 2) throw error;
      }
    }
  }
}
