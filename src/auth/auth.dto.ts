import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  Length,
  ValidateBy,
} from 'class-validator';

// Use the documented UTF-16 boundary (also Android String.length), rather than
// validator.js's visual-length rules for surrogate pairs/variation selectors.
function PasswordLength(min: number): PropertyDecorator {
  return ValidateBy({
    name: 'passwordLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length >= min && value.length <= 128,
      defaultMessage: () =>
        `password must contain ${min} to 128 UTF-16 code units`,
    },
  });
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(254)
  @Matches(/^[!-~]+$/)
  @IsEmail({ allow_utf8_local_part: false })
  email!: string;

  @IsString()
  @PasswordLength(1)
  password!: string;
}
export class RegisterDto extends LoginDto {
  // Redeclaring validation metadata suppresses inherited validators of the same
  // type in class-validator, so the complete password boundary belongs here.
  @IsString()
  @PasswordLength(12)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[\s\S]+$/)
  declare password: string;
}

export class RefreshTokenDto {
  @IsString()
  @Length(80, 80)
  @Matches(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
  refreshToken!: string;
}
export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(254)
  @Matches(/^[!-~]+$/)
  @IsEmail({ allow_utf8_local_part: false })
  email!: string;
}
export class ResetPasswordDto {
  @IsString()
  @Length(80, 80)
  @Matches(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsString()
  @PasswordLength(12)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[\s\S]+$/)
  newPassword!: string;
}
export class EmptyAuthDto {}
