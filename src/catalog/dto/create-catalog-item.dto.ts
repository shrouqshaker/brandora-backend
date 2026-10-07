import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CatalogItemMetadataDto } from './catalog-item-metadata.dto';

export class CreateCatalogItemDto extends CatalogItemMetadataDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}
