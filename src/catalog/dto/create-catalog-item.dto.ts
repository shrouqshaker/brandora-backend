import { Transform } from 'class-transformer';
import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateCatalogItemDto {
  @IsUUID()
  businessId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(5000)
  description?: string;

  // Use a decimal string to avoid floating-point rounding for prices.
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, {
    message:
      'basePrice must be a non-negative decimal string with up to 10 integer digits and 2 decimal places',
  })
  basePrice?: string | null;
}
