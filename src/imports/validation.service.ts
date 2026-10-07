import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportFileStorage } from './storage/import-file.storage';
import { RowValidator } from './validation/row-validator';
import { parseSavedMapping } from './validation/saved-mapping';

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportFileStorage,
    private readonly excel: ExcelAdapter,
    private readonly rows: RowValidator,
  ) {}

  async validate(importId: string) {
    const initial = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { status: true, mapping: true },
    });
    if (!initial)
      throw new AppHttpException(
        ErrorCode.IMPORT_JOB_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Import job not found',
      );
    if (initial.status !== ImportJobStatus.MAPPING_REQUIRED)
      throw new AppHttpException(
        ErrorCode.IMPORT_NOT_AWAITING_VALIDATION,
        HttpStatus.CONFLICT,
        'The import job is not awaiting validation',
      );
    if (!Array.isArray(initial.mapping) || initial.mapping.length === 0)
      throw new AppHttpException(
        ErrorCode.IMPORT_MAPPING_REQUIRED,
        HttpStatus.CONFLICT,
        'A confirmed mapping is required',
      );
    const claim = await this.prisma.importJob.updateMany({
      where: { id: importId, status: ImportJobStatus.MAPPING_REQUIRED },
      data: { status: ImportJobStatus.VALIDATING },
    });
    if (claim.count !== 1)
      throw new AppHttpException(
        ErrorCode.IMPORT_VALIDATION_ALREADY_STARTED,
        HttpStatus.CONFLICT,
        'Validation has already started or the job status changed',
      );

    try {
      // Re-read after claiming: a mapping confirmation may have won immediately
      // before our claim, but cannot change the mapping after VALIDATING begins.
      const job = await this.prisma.importJob.findUnique({
        where: { id: importId },
        select: {
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
      const mapping = parseSavedMapping(job.mapping, workbook.headers);
      const result = this.rows.validate(workbook.rows, mapping);
      const completed = await this.prisma.importJob.updateMany({
        where: { id: importId, status: ImportJobStatus.VALIDATING },
        data: {
          status: ImportJobStatus.READY,
          ...result.summary,
          errors: {
            summary: { ...result.summary },
            rows: result.invalidRows.map((row) => ({
              rowNumber: row.rowNumber,
              errors: row.errors.map((error) => ({ ...error })),
            })),
          },
        },
      });
      if (completed.count !== 1)
        throw new Error('Validation lifecycle changed before completion');
      return { importId, status: ImportJobStatus.READY, ...result };
    } catch (error: unknown) {
      this.logger.error(
        'Import validation failed',
        error instanceof Error ? error.stack : String(error),
      );
      try {
        await this.prisma.importJob.updateMany({
          where: { id: importId, status: ImportJobStatus.VALIDATING },
          data: {
            status: ImportJobStatus.FAILED,
            errors: {
              code: 'VALIDATION_FAILED',
              message: 'Workbook validation could not be completed',
            },
          },
        });
      } catch (failureError: unknown) {
        this.logger.error(
          'Unable to persist failed validation status',
          failureError instanceof Error
            ? failureError.stack
            : String(failureError),
        );
      }
      throw new AppHttpException(
        ErrorCode.IMPORT_VALIDATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Workbook validation could not be completed',
      );
    }
  }
}
