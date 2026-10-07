import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { STATUS_CODES } from 'node:http';
import { AppHttpException } from './app-http.exception';
import { ErrorCode } from './error-code';

export interface ApiErrorResponse {
  statusCode: number;
  code: ErrorCode;
  message: string | string[];
  error: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const statusCode = this.status(exception);
    const error = STATUS_CODES[statusCode] ?? 'HTTP Error';
    let code = ErrorCode.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'An internal server error occurred';

    if (exception instanceof AppHttpException) {
      code = exception.code;
      message = this.message(exception, error);
    } else if (statusCode < 500) {
      code = this.frameworkCode(statusCode);
      // Express body-parser/http-errors are not Nest HttpExceptions. Preserve
      // their HTTP status, but never echo raw request bodies or other internals.
      message =
        exception instanceof HttpException
          ? this.message(exception, error)
          : error;
      const type = (exception as { type?: unknown })?.type;
      if (type === 'entity.parse.failed')
        message = 'The request body is not valid JSON';
      if (type === 'entity.too.large')
        message = 'The request body exceeds the maximum allowed size';
    } else {
      // Unexpected errors are diagnostic information for server logs only.
      this.logger.error(
        'Unhandled HTTP error',
        exception instanceof Error ? exception.stack : 'Non-Error exception',
      );
    }

    const response: ApiErrorResponse = { statusCode, code, message, error };
    const adapter = this.adapterHost.httpAdapter;
    const target = host.switchToHttp().getResponse();
    if (adapter.isHeadersSent(target)) adapter.end(target);
    else adapter.reply(target, response, statusCode);
  }

  private status(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    // Match http-errors/Express statuses without trusting arbitrary thrown objects.
    const status =
      exception instanceof Error
        ? (exception as Error & { statusCode?: number }).statusCode
        : undefined;
    return typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
      ? status
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private message(
    exception: HttpException,
    fallback: string,
  ): string | string[] {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown } | null)?.message;
    if (typeof message === 'string') return message;
    if (
      Array.isArray(message) &&
      message.every((value) => typeof value === 'string')
    )
      return message;
    return fallback;
  }

  private frameworkCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      default:
        return ErrorCode.HTTP_ERROR;
    }
  }
}
