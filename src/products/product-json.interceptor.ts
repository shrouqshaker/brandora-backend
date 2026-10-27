import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { invalid } from './product-validation';

@Injectable()
export class ProductJsonBoundaryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const { body } = context.switchToHttp().getRequest<{ body?: unknown }>();
    const visit = (value: unknown, depth: number): void => {
      if (depth > 12)
        invalid('Request JSON nesting exceeds the supported depth');
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        // Nest removes these names recursively. Reject before pipes run so no
        // submitted option definition or attribute is silently lost.
        if (['__proto__', 'prototype', 'constructor'].includes(key.trim()))
          invalid(
            'JSON keys __proto__, prototype and constructor are reserved',
          );
        visit(child, depth + 1);
      }
    };
    visit(body, 0);
    return next.handle();
  }
}
