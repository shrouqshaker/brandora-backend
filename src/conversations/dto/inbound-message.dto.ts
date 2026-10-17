import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MessageType } from '../../generated/prisma/client';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
/** Blank strings mean "not provided" (WhatsApp sometimes omits the profile name). */
const blankToUndefined = ({ value }: { value: unknown }): unknown => {
  const trimmed = trim({ value });
  return trimmed === '' ? undefined : trimmed;
};

/** Body of the dev-only endpoint; mirrors what the WhatsApp webhook will extract later. */
export class InboundMessageDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalMessageId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  content!: string;

  @IsOptional()
  @IsEnum(MessageType)
  messageType?: MessageType;
}
