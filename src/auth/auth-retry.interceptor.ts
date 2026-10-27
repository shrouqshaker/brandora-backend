import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError } from 'rxjs';

@Injectable()
export class AuthRetryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((error) => {
        if (error instanceof HttpException && error.getStatus() === 429) {
          const response = context.switchToHttp().getResponse();
          if (!response.getHeader('Retry-After'))
            response.setHeader('Retry-After', '1');
        }
        return throwError(() => error);
      }),
    );
  }
}
