import { HttpStatus } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { Prisma } from '../generated/prisma/client';

export type ProductOptions = Record<string, string[]>;
export type VariantOptions = Record<string, string>;
export const MAX_OPTION_BYTES = 1500;

export function invalid(
  message: string,
  code = ErrorCode.VALIDATION_ERROR,
): never {
  throw new AppHttpException(code, HttpStatus.BAD_REQUEST, message);
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

// No case folding or Unicode rewriting: trimmed names/values are case-sensitive.
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    invalid(
      `Option names/values must be nonblank strings of at most ${max} characters`,
    );
  return value.trim();
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function productOptions(value: unknown): ProductOptions {
  if (!plainObject(value)) invalid('options must be a JSON object');
  if (Object.keys(value).length > 10)
    invalid('options may contain at most 10 keys');
  const result: ProductOptions = Object.create(null) as ProductOptions;
  const largestCombination: VariantOptions = Object.create(
    null,
  ) as VariantOptions;
  for (const [rawKey, rawValues] of Object.entries(value)) {
    const key = text(rawKey, 60);
    if (Object.hasOwn(result, key))
      invalid('Duplicate option names after trimming');
    if (
      !Array.isArray(rawValues) ||
      rawValues.length < 1 ||
      rawValues.length > 50
    )
      invalid('Each option needs 1 to 50 allowed values');
    const values = rawValues.map((v: unknown) => text(v, 100));
    if (new Set(values).size !== values.length)
      invalid('Duplicate option values after trimming');
    result[key] = values;
    largestCombination[key] = values.reduce((a, b) =>
      jsonBytes(a) >= jsonBytes(b) ? a : b,
    );
  }
  if (jsonBytes(value) > 16384)
    invalid('options exceeds 16384 UTF-8 JSON bytes');
  // Bound every possible selection, including escaped and multibyte strings.
  if (jsonBytes(largestCombination) > MAX_OPTION_BYTES)
    invalid(
      `Every possible option combination must fit ${MAX_OPTION_BYTES} UTF-8 JSON bytes`,
    );
  return result;
}

export function variantOptions(
  value: unknown,
  definitions: ProductOptions,
): VariantOptions {
  if (!plainObject(value))
    invalid(
      'optionValues must be a JSON object',
      ErrorCode.VARIANT_OPTIONS_INVALID,
    );
  if (Object.keys(value).length > 10)
    invalid(
      'optionValues exceeds the supported size',
      ErrorCode.VARIANT_OPTIONS_INVALID,
    );
  const result: VariantOptions = Object.create(null) as VariantOptions;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = text(rawKey, 60);
    if (Object.hasOwn(result, key))
      invalid(
        'Duplicate option names after trimming',
        ErrorCode.VARIANT_OPTIONS_INVALID,
      );
    if (typeof rawValue !== 'string')
      invalid(
        'Each selected option value must be a string',
        ErrorCode.VARIANT_OPTIONS_INVALID,
      );
    const selected = rawValue.trim();
    if (
      !Object.hasOwn(definitions, key) ||
      !definitions[key].includes(selected)
    )
      invalid(
        'Selected values must match the parent product options',
        ErrorCode.VARIANT_OPTIONS_INVALID,
      );
    result[key] = selected;
  }
  if (jsonBytes(value) > MAX_OPTION_BYTES)
    invalid(
      'optionValues exceeds the supported size',
      ErrorCode.VARIANT_OPTIONS_INVALID,
    );
  if (Object.keys(result).length !== Object.keys(definitions).length)
    invalid(
      'Exactly one selected value is required for every product option',
      ErrorCode.VARIANT_OPTIONS_INVALID,
    );
  return result;
}

export function attributes(value: unknown): Prisma.InputJsonObject {
  if (!plainObject(value)) invalid('attributes must be a JSON object');
  // HTTP JSON is acyclic. Bound nesting explicitly for non-HTTP callers too.
  const visit = (v: unknown, depth: number): void => {
    if (depth > 10) invalid('attributes may nest at most 10 levels');
    if (v !== null && typeof v === 'object') {
      for (const item of Object.values(v)) visit(item, depth + 1);
    } else if (
      !['string', 'boolean', 'number'].includes(typeof v) &&
      v !== null
    ) {
      invalid('attributes must contain JSON values');
    } else if (typeof v === 'number' && !Number.isFinite(v))
      invalid('attributes must contain finite JSON numbers');
  };
  visit(value, 0);
  if (jsonBytes(value) > 16384)
    invalid('attributes must be a JSON object of at most 16384 UTF-8 bytes');
  return value as Prisma.InputJsonObject;
}

export function requirePatch(dto: object): void {
  if (!Object.values(dto).some((v) => v !== undefined))
    invalid('At least one editable field must be supplied');
}
