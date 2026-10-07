import { HttpException } from '@nestjs/common';
import { ErrorCode } from './error-code';

/** Only supply intentional, public-safe messages here, including for known server failures. */
export class AppHttpException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    statusCode: number,
    message: string | string[],
  ) {
    super({ code, message }, statusCode);
  }
}
