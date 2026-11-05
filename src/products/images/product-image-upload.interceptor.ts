import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ErrorCode } from '../../common/errors/error-code';
import { fail } from '../product-access.service';
import { MAX_IMAGE_BYTES } from './cloudinary.service';

@Injectable()
export class ProductImageUploadInterceptor extends FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 5 },
  ],
  {
    storage: memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: 5,
      fields: 0,
      parts: 5,
      fieldSize: 400,
    },
  },
) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE
      )
        fail(
          ErrorCode.PRODUCT_IMAGE_TOO_LARGE,
          HttpStatus.PAYLOAD_TOO_LARGE,
          'Image exceeds 5 MB',
        );
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.BAD_REQUEST
      )
        fail(
          ErrorCode.PRODUCT_IMAGE_INVALID,
          HttpStatus.BAD_REQUEST,
          'Send one file or up to five files, without image attributes',
        );
      throw error;
    }
  }
}
