import { IsBoolean, ValidateIf } from 'class-validator';

export class UpdateBusinessSettingsDto {
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
