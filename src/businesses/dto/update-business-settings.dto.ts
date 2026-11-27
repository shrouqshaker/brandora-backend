import {
  IsBoolean,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateBusinessSettingsDto {
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(5000)
  returnPolicy?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(5000)
  paymentNotes?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(5000)
  deliveryNotes?: string | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
  deliveryFee?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  acceptsCash?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  acceptsOnlinePayment?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  pickupEnabled?: boolean;
}
