import { IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class AnalyzeExcelDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(31)
  sheetName?: string;
}
