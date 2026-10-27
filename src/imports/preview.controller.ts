import { AuthScope } from '../auth/auth-policy';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PreviewService } from './preview.service';
import { ImportPaginationDto } from './dto/import-pagination.dto';

@Controller('imports/:importId/preview')
@AuthScope('import')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Get()
  get(
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Query() pagination: ImportPaginationDto,
  ) {
    return this.preview.generate(importId, pagination);
  }
}
