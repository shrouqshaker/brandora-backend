import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { PreviewService } from './preview.service';

@Controller('imports/:importId/preview')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Get()
  get(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.preview.generate(importId);
  }
}
