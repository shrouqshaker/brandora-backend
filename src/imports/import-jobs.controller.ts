import { AuthScope } from '../auth/auth-policy';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ImportHistoryPaginationDto } from './dto/import-pagination.dto';
import { ImportsService } from './imports.service';

@Controller()
@AuthScope('import')
export class ImportJobsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('imports/:importId')
  get(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.imports.getJob(importId);
  }

  @Get('businesses/:businessId/imports')
  @AuthScope('params')
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() pagination: ImportHistoryPaginationDto,
  ) {
    return this.imports.listJobs(businessId, pagination);
  }
}
