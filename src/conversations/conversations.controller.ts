import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { ConversationsService } from './conversations.service';
import { ListConversationsDto } from './dto/list-conversations.dto';

@Controller('businesses/:businessId/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Query() query: ListConversationsDto,
  ) {
    return this.conversations.list(businessId, query);
  }

  @Get(':conversationId')
  getOne(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
  ) {
    return this.conversations.getOne(businessId, conversationId);
  }

  @Get(':conversationId/messages')
  messages(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.conversations.listMessages(
      businessId,
      conversationId,
      pagination,
    );
  }
}
