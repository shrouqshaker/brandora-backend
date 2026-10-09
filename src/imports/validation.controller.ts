import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ValidationService } from './validation.service';
import { ImportPaginationDto } from './dto/import-pagination.dto';

@Controller('imports/:importId')
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}

  @Post('validate')
  validate(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.validation.validate(importId);
  }

  @Get('validation-results')
  results(
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Query() pagination: ImportPaginationDto,
  ) {
    return this.validation.results(importId, pagination);
  }
}
