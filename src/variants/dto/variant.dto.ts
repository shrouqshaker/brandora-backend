import { Transform } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class VariantMetadataDto {
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sku?: string | null;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
  unitPrice?: string | null;
}

export class CreateVariantDto extends VariantMetadataDto {
  @Allow()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.optionValues)
  optionValues!: unknown;
}

export class UpdateVariantDto extends VariantMetadataDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @Allow()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.optionValues)
  optionValues?: unknown;
}
