import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { fail } from './product-access.service';
import { ProductOptions } from './product-validation';

export function colorOption(options: ProductOptions, name: string | null) {
  if (name !== null && !Object.hasOwn(options, name))
    fail(
      ErrorCode.VALIDATION_ERROR,
      HttpStatus.BAD_REQUEST,
      'colorOptionName must name an existing product option',
    );
}
