import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import {
  MaxCharacters,
  MESSAGE_MAX_CHARACTERS,
} from '../../messages/message-limits';

export class SendMessageDto {
  /** 1 to 4096 characters (code points) after trimming: one WhatsApp message. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxCharacters(MESSAGE_MAX_CHARACTERS)
  content!: string;
}
