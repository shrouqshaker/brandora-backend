import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '../../generated/prisma/client';

export class WorkingDayDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @IsBoolean()
  isOpen!: boolean;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  opensAt?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  closesAt?: string | null;
}

export class PutWorkingHoursDto {
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ArrayUnique((day: WorkingDayDto) => day?.dayOfWeek)
  @ValidateNested({ each: true })
  @Type(() => WorkingDayDto)
  days!: WorkingDayDto[];
}
