import { Transform } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '../../generated/prisma/client';

/** Editable metadata shared by create and patch; inventory is intentionally absent. */
export class CatalogItemMetadataDto {
  @IsUUID()
  businessId!: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  externalKey?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(200)
  category?: string | null;

  // Preserve decimal strings instead of accepting floating-point JSON numbers.
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, {
    message:
      'basePrice must be a non-negative decimal string with up to 10 integer digits and 2 decimal places',
  })
  basePrice?: string | null;

  // Shape validation belongs to the service so it returns CATALOG_ATTRIBUTES_INVALID.
  @Allow()
  attributes?: Prisma.InputJsonObject | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
