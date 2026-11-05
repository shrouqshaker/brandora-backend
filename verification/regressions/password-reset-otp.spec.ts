import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash } from 'node:crypto';
import { ResetPasswordDto } from '../../src/auth/auth.dto';
import { resetOtp, resetOtpHash } from '../../src/auth/password-reset-otp';

const secret = 'non-secret-otp-test-key'.repeat(3);
const body = {
  email: 'owner@example.invalid',
  otp: '01234567',
  newPassword: 'NewSecurePassword123!',
};
const validate = (data: object) =>
  validateSync(plainToInstance(ResetPasswordDto, data), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('OTP-only password recovery contract', () => {
  it('accepts a leading zero and normalizes the email without changing the OTP', () => {
    const dto = plainToInstance(ResetPasswordDto, {
      ...body,
      email: ' Owner@Example.Invalid ',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.email).toBe(body.email);
    expect(dto.otp).toBe('01234567');
  });
  it.each([
    '',
    '123456',
    '123456789',
    '1234567a',
    ' 01234567',
    '01234567 ',
    '01234567\n',
    '01234567\r\n',
    '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667',
    12345678,
    null,
  ])('rejects malformed OTP %#', (otp) => {
    expect(validate({ ...body, otp }).length).toBeGreaterThan(0);
  });
  it('rejects legacy token input and requires an email', () => {
    expect(validate({ ...body, token: 'legacy-token' }).length).toBeGreaterThan(
      0,
    );
    expect(
      validate({ otp: body.otp, newPassword: body.newPassword }).length,
    ).toBeGreaterThan(0);
    expect(
      validate({
        email: body.email,
        token: 'legacy-token',
        newPassword: body.newPassword,
      }).length,
    ).toBeGreaterThan(0);
  });
  it('generates exactly eight ASCII digits using the cryptographic RNG', () => {
    for (let i = 0; i < 50; i++) expect(resetOtp()).toMatch(/^[0-9]{8}$/);
  });
  it('binds the stored HMAC to account, code and server secret, rather than an offline-guessable SHA digest', () => {
    const digest = resetOtpHash(body.email, body.otp, secret);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(
      createHash('sha256').update(body.otp).digest('hex'),
    );
    expect(digest).not.toBe(
      resetOtpHash('other@example.invalid', body.otp, secret),
    );
    expect(digest).not.toBe(resetOtpHash(body.email, '11234567', secret));
    expect(digest).not.toBe(
      resetOtpHash(body.email, body.otp, secret + 'rotated'),
    );
  });
});
