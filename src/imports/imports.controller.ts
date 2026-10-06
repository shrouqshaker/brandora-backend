import { Body, Controller, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AnalyzeExcelDto } from './dto/analyze-excel.dto';
import { ImportsService } from './imports.service';

@Controller('businesses/:businessId/imports/excel')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('analyze')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 },
  }))
  analyze(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: AnalyzeExcelDto,
  ) {
    return this.imports.analyze(businessId, file, dto.sheetName);
  }
}
