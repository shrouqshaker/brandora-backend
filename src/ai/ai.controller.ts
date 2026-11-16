import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthScope } from '../auth/auth-policy';
import { AiRespondDto, AiToolDto } from './ai.dto';
import { AiInternalGuard } from './ai-internal.guard';
import { AiService } from './ai.service';
import { AiClaims } from './ai-security';

@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}
  @Post('businesses/:businessId/ai/respond')
  @HttpCode(200)
  @AuthScope('params')
  respond(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: AiRespondDto,
  ) {
    return this.ai.respond(businessId, dto);
  }
  @Post('internal/ai/data')
  @HttpCode(200)
  @AuthScope('public') // Exempt ONLY from owner JWT; service guard below is mandatory.
  @UseGuards(AiInternalGuard)
  data(@Req() req: { aiClaims: AiClaims }, @Body() dto: AiToolDto) {
    return this.ai.tool(req.aiClaims, dto);
  }
}
