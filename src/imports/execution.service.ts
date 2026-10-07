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

type ValidRow = RowValidationResult['validRows'][number];
export interface ExecutedRow {
  rowNumber: number;
  externalKey: string | null;
  catalogItemId: string;
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
        'Execution has already started or the job status changed',
      );

    const inserted: ExecutedRow[] = [];
    const updated: ExecutedRow[] = [];
    const unchanged: ExecutedRow[] = [];
    const failedRows: FailedRow[] = [];
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
      rows: (validated?.invalidRows ?? []).map((row) => ({
        rowNumber: row.rowNumber,
        errors: row.errors.map((error) => ({ ...error })),
      })),
      execution: failedRows.map((row) => ({ ...row })),
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
      validated = this.rows.validate(
        workbook.rows,
        parseSavedMapping(job.mapping, workbook.headers),
      );
      for (const row of validated.validRows) {
        try {
          const result = await this.executeRow(importId, job.businessId, row);
          if (result.action === 'INSERT') inserted.push(result.row);
          else if (result.action === 'UPDATE') updated.push(result.row);
          else unchanged.push(result.row);
        } catch (error: unknown) {
          // Connectivity/pool failures are job-level; continuing cannot meaningfully process rows.
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
            (error instanceof AppHttpException &&
              error.getStatus() === HttpStatus.CONFLICT) ||
            error instanceof ConflictException ||
            code === 'P2002' ||
            code === 'P2034';
          failedRows.push({
            rowNumber: row.rowNumber,
            code: conflict ? 'EXECUTION_CONFLICT' : 'ROW_EXECUTION_FAILED',
            message: conflict
              ? 'Catalog data changed concurrently; this row was not applied'
              : 'This row could not be applied',
          });
        }
      }
      const status =
        validated.invalidRows.length || failedRows.length
          ? ImportJobStatus.COMPLETED_WITH_ERRORS
          : ImportJobStatus.COMPLETED;
      const completed = await this.prisma.importJob.updateMany({
        where: { id: importId, status: ImportJobStatus.IMPORTING },
        data: { status, ...counters(), errors: errors() },
      });
      if (completed.count !== 1)
        throw new Error('Execution lifecycle changed before completion');
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
    } catch (error: unknown) {
      this.logger.error(
        'Import execution failed',
        error instanceof Error ? error.stack : String(error),
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

  private executeRow(importId: string, businessId: string, row: ValidRow) {
    return this.prisma.$transaction(
      async (tx) => {
        const externalKey = row.data.externalKey ?? null;
        const existing =
          externalKey === null
            ? null
            : await tx.catalogItem.findUnique({
                where: { businessId_externalKey: { businessId, externalKey } },
              });
        const plan = this.planner.plan(
          businessId,
          [row],
          existing ? [existing] : [],
        );
        const quantity = row.data.stockQuantity;
        const hasStock = quantity !== undefined && quantity !== null;
        const trackingChange =
          hasStock && existing !== null && !existing.trackInventory;
        let catalogItemId: string;
        let action: 'INSERT' | 'UPDATE' | 'UNCHANGED';
        if (!existing) {
          // Explicit whitelist: never pass stock, variant metadata, or active flags to ordinary writes.
          const data: Prisma.CatalogItemUncheckedCreateInput = {
            businessId,
            name: row.data.name!,
          };
          for (const field of [
            'externalKey',
            'description',
            'category',
            'basePrice',
          ] as const) {
            const value = row.data[field];
            if (value != null) data[field] = value;
          }
          const attributes = plan.inserts[0].data.attributes;
          if (attributes) data.attributes = attributes;
          if (hasStock) data.trackInventory = true;
          // stockQuantity remains the schema's null default until InventoryService initializes it.
          catalogItemId = (
            await tx.catalogItem.create({ data, select: { id: true } })
          ).id;
          action = 'INSERT';
        } else {
          catalogItemId = existing.id;
          const data: Prisma.CatalogItemUncheckedUpdateInput = {};
          const changes = plan.updates[0]?.changes ?? {};
          for (const field of [
            'name',
            'externalKey',
            'description',
            'category',
            'basePrice',
          ] as const) {
            if (changes[field]) data[field] = row.data[field]!;
          }
          if (changes.attributes)
            data.attributes = changes.attributes.to as Prisma.InputJsonObject;
          if (trackingChange) data.trackInventory = true;
          if (Object.keys(data).length)
            await tx.catalogItem.update({ where: { id: catalogItemId }, data });
          action =
            plan.updates.length || trackingChange ? 'UPDATE' : 'UNCHANGED';
        }
        if (hasStock) {
          await this.inventory.setQuantity(
            { id: catalogItemId, businessId },
            quantity,
            existing
              ? InventoryMovementType.IMPORT_UPDATE
              : InventoryMovementType.INITIAL_IMPORT,
            { type: 'IMPORT_JOB', id: importId },
            tx,
          );
        }
        return {
          action,
          row: { rowNumber: row.rowNumber, externalKey, catalogItemId },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
