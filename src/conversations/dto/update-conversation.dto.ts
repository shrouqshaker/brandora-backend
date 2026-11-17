import { IsBoolean } from 'class-validator';

export class UpdateConversationDto {
  /** true = the AI answers this chat, false = the owner answers herself. */
  @IsBoolean()
  aiEnabled!: boolean;
}
