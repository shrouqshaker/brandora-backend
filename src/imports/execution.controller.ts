import { AuthScope } from '../auth/auth-policy';
import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ExecutionService } from './execution.service';

@Controller('imports/:importId/execute')
@AuthScope('import')
export class ExecutionController {
  constructor(private readonly execution: ExecutionService) {}

  @Post()
  @HttpCode(200)
  execute(@Param('importId', new ParseUUIDPipe()) importId: string) {
    return this.execution.execute(importId);
  }
}
