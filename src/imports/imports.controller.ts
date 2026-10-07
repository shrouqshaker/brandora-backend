import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ExcelUploadInterceptor } from './interceptors/excel-upload.interceptor';
import { AnalyzeExcelDto } from './dto/analyze-excel.dto';
import { ImportsService } from './imports.service';

@Controller('businesses/:businessId/imports/excel')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('analyze')
  @UseInterceptors(ExcelUploadInterceptor)
  analyze(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: AnalyzeExcelDto,
  ) {
    return this.imports.analyze(businessId, file, dto.sheetName);
  }
}
