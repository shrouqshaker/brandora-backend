import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import {
  ImportJobStatus,
  ImportSourceType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelAdapter } from './adapters/excel.adapter';
import { ImportFileStorage } from './storage/import-file.storage';

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly excel: ExcelAdapter,
    private readonly storage: ImportFileStorage,
  ) {}

  async analyze(
    businessId: string,
    file: Express.Multer.File | undefined,
    sheetName?: string,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business)
      throw new AppHttpException(
        ErrorCode.BUSINESS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Business not found',
      );
    const upload = this.excel.validateUpload(file);
    const fileKey = await this.storage.save(upload.buffer);
    try {
      const analysis = await this.excel.analyze(
        await this.storage.read(fileKey),
        sheetName,
      );
      const job = await this.prisma.importJob.create({
        data: {
          businessId,
          sourceType: ImportSourceType.EXCEL,
          status: ImportJobStatus.MAPPING_REQUIRED,
          fileName: upload.originalname,
          fileKey,
          sheetName: analysis.selectedSheetName,
          headerRow: analysis.headerRow,
          totalRows: analysis.totalRows,
        },
        select: { id: true, status: true },
      });
      return { importJobId: job.id, status: job.status, ...analysis };
    } catch (error: unknown) {
      try {
        await this.storage.delete(fileKey);
      } catch (cleanupError: unknown) {
        this.logger.error(
          `Failed to clean up import file ${fileKey}`,
          cleanupError instanceof Error
            ? cleanupError.stack
            : String(cleanupError),
        );
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new AppHttpException(
          ErrorCode.BUSINESS_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Business not found',
        );
      }
      throw error;
    }
  }
}
