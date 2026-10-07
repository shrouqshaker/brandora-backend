import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MappingType } from '../mapping-fields';

export class ColumnMappingDto {
  @IsString()
  @MaxLength(1000)
  sourceColumn!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(16384)
  sourceColumnIndex?: number;

  @IsEnum(MappingType)
  type!: MappingType;

  // Explicit null is required for IGNORE and UNMAPPED. Conditional target
  // semantics are checked by the mapping service, not against catalog rows.
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(64)
  target!: string | null;
}

export class ConfirmMappingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16384)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ColumnMappingDto)
  mapping!: ColumnMappingDto[];
}
