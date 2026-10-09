import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportFileStorage } from './storage/import-file.storage';
import { RowValidator } from './validation/row-validator';
import { RowValidationResult } from './validation/row.types';
import { parseSavedMapping } from './validation/saved-mapping';
import { ImportPlanner } from './preview/import-planner';
import { ExistingCatalogItem } from './preview/preview.types';
import { ImportPaginationDto } from './dto/import-pagination.dto';
import { importPageRowNumbers, importPagination } from './paginate-import-rows';

@Injectable()
export class PreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportFileStorage,
    private readonly excel: ExcelAdapter,
    private readonly rows: RowValidator,
    private readonly planner: ImportPlanner,
  ) {}

  async generate(importId: string, pagination = new ImportPaginationDto()) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: {
        id: true,
        businessId: true,
        status: true,
        fileKey: true,
        sheetName: true,
        headerRow: true,
        mapping: true,
      },
    });
    if (!job)
      throw new AppHttpException(
        ErrorCode.IMPORT_JOB_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Import job not found',
      );
    if (job.status !== ImportJobStatus.READY)
      throw new AppHttpException(
        ErrorCode.IMPORT_NOT_READY,
        HttpStatus.CONFLICT,
        'The import job must be READY before preview',
      );
    if (
      !job.fileKey ||
      !job.sheetName ||
      job.headerRow === null ||
      !Array.isArray(job.mapping) ||
      job.mapping.length === 0
    ) {
      throw new AppHttpException(
        ErrorCode.IMPORT_WORKBOOK_UNAVAILABLE,
        HttpStatus.CONFLICT,
        'The import job has no retained mapped workbook',
      );
    }
    let validated: RowValidationResult;
    try {
      const workbook = await this.excel.readDataRows(
        await this.storage.read(job.fileKey),
        job.sheetName,
        job.headerRow,
      );
      validated = this.rows.validate(
        workbook.rows,
        parseSavedMapping(job.mapping, workbook.headers),
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        throw new AppHttpException(
          ErrorCode.IMPORT_WORKBOOK_UNAVAILABLE,
          HttpStatus.CONFLICT,
          'The retained workbook is unavailable',
        );
      throw new AppHttpException(
        ErrorCode.IMPORT_WORKBOOK_READ_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Unable to rebuild the import preview from the retained workbook',
      );
    }
    const keys = [
      ...new Set(
        validated.validRows.flatMap((row) =>
          row.data.externalKey == null ? [] : [row.data.externalKey],
        ),
      ),
    ];
    const existing: ExistingCatalogItem[] = [];
    for (let offset = 0; offset < keys.length; offset += 1000) {
      existing.push(
        ...(await this.prisma.catalogItem.findMany({
          where: {
            businessId: job.businessId,
            externalKey: { in: keys.slice(offset, offset + 1000) },
          },
          select: {
            id: true,
            businessId: true,
            externalKey: true,
            name: true,
            description: true,
            category: true,
            basePrice: true,
            stockQuantity: true,
            attributes: true,
          },
        })),
      );
    }
    const plan = this.planner.plan(
      job.businessId,
      validated.validRows,
      existing,
    );
    const page = importPageRowNumbers(
      [plan.inserts, plan.updates, plan.unchanged, validated.invalidRows],
      pagination,
    );
    return {
      importId: job.id,
      status: ImportJobStatus.READY,
      summary: {
        ...validated.summary,
        willInsert: plan.inserts.length,
        willUpdate: plan.updates.length,
        unchanged: plan.unchanged.length,
      },
      pagination: importPagination(
        pagination,
        validated.validRows.length + validated.invalidRows.length,
      ),
      inserts: plan.inserts.filter((row) => page.has(row.rowNumber)),
      updates: plan.updates.filter((row) => page.has(row.rowNumber)),
      unchanged: plan.unchanged.filter((row) => page.has(row.rowNumber)),
      invalidRows: validated.invalidRows.filter((row) =>
        page.has(row.rowNumber),
      ),
    };
  }
}
