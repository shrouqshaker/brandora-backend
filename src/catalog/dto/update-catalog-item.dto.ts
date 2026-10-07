import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { CatalogItemMetadataDto } from './catalog-item-metadata.dto';

export class UpdateCatalogItemDto extends CatalogItemMetadataDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
