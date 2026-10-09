import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportFileStorage } from './storage/import-file.storage';
import { RowValidator } from './validation/row-validator';
import { parseSavedMapping } from './validation/saved-mapping';
import { ImportPaginationDto } from './dto/import-pagination.dto';
import { importPageRowNumbers, importPagination } from './paginate-import-rows';
import { RowValidationResult } from './validation/row.types';

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportFileStorage,
    private readonly excel: ExcelAdapter,
    private readonly rows: RowValidator,
  ) {}

  async results(importId: string, pagination: ImportPaginationDto) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { status: true, fileKey: true, errors: true },
    });
    if (!job)
      throw new AppHttpException(
        ErrorCode.IMPORT_JOB_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Import job not found',
      );
    const availableStates: ImportJobStatus[] = [
      ImportJobStatus.READY,
      ImportJobStatus.IMPORTING,
      ImportJobStatus.COMPLETED,
      ImportJobStatus.COMPLETED_WITH_ERRORS,
      ImportJobStatus.FAILED,
      ImportJobStatus.CANCELLED,
    ];
    const validationFailed =
      job.errors &&
      typeof job.errors === 'object' &&
      !Array.isArray(job.errors) &&
      job.errors.code === 'VALIDATION_FAILED';
    if (
      !job.fileKey ||
      !availableStates.includes(job.status) ||
      validationFailed
    )
      this.resultsUnavailable();
    let result: RowValidationResult;
    try {
      const snapshot = JSON.parse(
        (await this.storage.readValidationResult(job.fileKey!)).toString(
          'utf8',
        ),
      );
      if (
        snapshot.version !== 1 ||
        snapshot.importId !== importId ||
        !snapshot.result ||
        !Array.isArray(snapshot.result.validRows) ||
        !Array.isArray(snapshot.result.invalidRows) ||
        !snapshot.result.summary
      )
        throw new Error('Invalid validation snapshot');
      result = snapshot.result;
      const { totalRows, validRows, invalidRows, skippedRows } = result.summary;
      const positions = [...result.validRows, ...result.invalidRows].map(
        (row) => row.rowNumber,
      );
      if (
        ![totalRows, validRows, invalidRows, skippedRows].every(
          (count) => Number.isSafeInteger(count) && count >= 0,
        ) ||
        totalRows !== validRows + invalidRows + skippedRows ||
        validRows !== result.validRows.length ||
        invalidRows !== result.invalidRows.length ||
        !positions.every((row) => Number.isSafeInteger(row) && row > 0) ||
        new Set(positions).size !== positions.length
      )
        throw new Error('Inconsistent validation snapshot');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        this.resultsUnavailable();
      throw new AppHttpException(
        ErrorCode.INTERNAL_SERVER_ERROR,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Unable to read stored validation results',
      );
    }
    const page = importPageRowNumbers(
      [result.validRows, result.invalidRows],
      pagination,
    );
    return {
      importId,
      status: job.status,
      summary: result.summary,
      pagination: importPagination(
        pagination,
        result.validRows.length + result.invalidRows.length,
      ),
      validRows: result.validRows.filter((row) => page.has(row.rowNumber)),
      invalidRows: result.invalidRows.filter((row) => page.has(row.rowNumber)),
    };
  }

  private resultsUnavailable(): never {
    throw new AppHttpException(
      ErrorCode.IMPORT_VALIDATION_RESULTS_UNAVAILABLE,
      HttpStatus.CONFLICT,
      'Stored validation results are not available for this import job',
    );
  }

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

    let snapshotKey: string | undefined;
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
      await this.storage.saveValidationResult(
        job.fileKey,
        Buffer.from(JSON.stringify({ version: 1, importId, result })),
      );
      snapshotKey = job.fileKey;
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
      return {
        importId,
        status: ImportJobStatus.READY,
        summary: result.summary,
      };
    } catch (error: unknown) {
      this.logger.error(
        'Import validation failed',
        error instanceof Error ? error.stack : String(error),
      );
      try {
        const failed = await this.prisma.importJob.updateMany({
          where: { id: importId, status: ImportJobStatus.VALIDATING },
          data: {
            status: ImportJobStatus.FAILED,
            errors: {
              code: 'VALIDATION_FAILED',
              message: 'Workbook validation could not be completed',
            },
          },
        });
        if (failed.count === 1 && snapshotKey)
          await this.storage.deleteValidationResult(snapshotKey);
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
