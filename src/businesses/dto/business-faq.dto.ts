import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateBusinessFaqDto {
  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  question?: string;

  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  answer?: string;

  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  position?: number;

  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class CreateBusinessFaqDto extends UpdateBusinessFaqDto {
  @ValidateIf(() => true)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  declare question: string;

  @ValidateIf(() => true)
  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  declare answer: string;
}
