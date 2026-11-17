import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { ConversationsService } from './conversations.service';
import { ListConversationsDto } from './dto/list-conversations.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { AuthScope } from '../auth/auth-policy';

@Controller('businesses/:businessId/conversations')
@AuthScope('params')
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

  @Patch(':conversationId')
  update(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversations.setAiEnabled(
      businessId,
      conversationId,
      dto.aiEnabled,
    );
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

  /** The owner answers from the app. 201 with the message (SENT or FAILED). */
  @Post(':conversationId/messages')
  reply(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.conversations.ownerReply(
      businessId,
      conversationId,
      dto.content,
    );
  }
}
