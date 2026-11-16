import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ConversationStatus } from '../../generated/prisma/client';

export class ListConversationsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;
}
