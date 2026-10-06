import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ValidationService } from './validation.service';

@Controller('imports/:importId/validate')
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}

  @Post()
  validate(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.validation.validate(importId);
  }
}
