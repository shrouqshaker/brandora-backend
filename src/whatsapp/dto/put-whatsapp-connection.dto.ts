import { IsBoolean, IsOptional, Matches } from 'class-validator';

export class PutWhatsAppConnectionDto {
  /** From Meta: WhatsApp > API Setup > Phone number ID. Digits only. */
  @Matches(/^\d{6,30}$/, { message: 'phoneNumberId must be 6 to 30 digits' })
  phoneNumberId!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}