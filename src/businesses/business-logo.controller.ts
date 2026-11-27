import {
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthScope } from '../auth/auth-policy';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { MAX_IMAGE_BYTES } from '../products/images/cloudinary.service';
import { BusinessLogoService } from './business-logo.service';

@Injectable()
export class BusinessLogoUploadInterceptor extends FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES + 1, files: 1, fields: 0, parts: 1 },
}) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 413)
        throw new AppHttpException(
          ErrorCode.BUSINESS_LOGO_TOO_LARGE,
          HttpStatus.PAYLOAD_TOO_LARGE,
          'Logo exceeds 10 MB',
        );
      if (error instanceof HttpException && error.getStatus() === 400)
        throw new AppHttpException(
          ErrorCode.BUSINESS_LOGO_INVALID,
          HttpStatus.BAD_REQUEST,
          'Send one file part without additional fields',
        );
      throw error;
    }
  }
}

@Controller('businesses/:businessId/logo')
@AuthScope('params')
export class BusinessLogoController {
  constructor(private readonly logos: BusinessLogoService) {}
  @Put()
  @UseInterceptors(BusinessLogoUploadInterceptor)
  upload(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.logos.upload(businessId, file);
  }
  @Delete()
  remove(@Param('businessId', new ParseUUIDPipe()) businessId: string) {
    return this.logos.remove(businessId);
  }
}
