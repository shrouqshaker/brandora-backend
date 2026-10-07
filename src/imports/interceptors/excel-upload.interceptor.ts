import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppHttpException } from '../../common/errors/app-http.exception';
import { ErrorCode } from '../../common/errors/error-code';

@Injectable()
export class ExcelUploadInterceptor extends FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 },
}) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error: unknown) {
      // Nest transforms Multer's LIMIT_FILE_SIZE into an HTTP 413 before this catch.
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE
      ) {
        throw new AppHttpException(
          ErrorCode.EXCEL_FILE_TOO_LARGE,
          HttpStatus.PAYLOAD_TOO_LARGE,
          'The Excel file exceeds the maximum allowed size of 10 MB.',
        );
      }
      throw error;
    }
  }
}
