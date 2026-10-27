import { Transform } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ProductMetadataDto {
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsUUID()
  categoryId?: string | null;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
  basePrice?: string | null;

  @Allow()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.options)
  options?: unknown;

  @Allow()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.attributes)
  attributes?: unknown;

  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class CreateProductDto extends ProductMetadataDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

export class UpdateProductDto extends ProductMetadataDto {
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
