import { createHmac, randomInt } from 'node:crypto';

export function resetOtp() {
  return randomInt(0, 100_000_000).toString().padStart(8, '0');
}

// Low-entropy codes must not be stored as unkeyed hashes. Bind the code to the
// account and a dedicated HMAC context; never persist or log its plaintext.
export function resetOtpHash(email: string, otp: string, secret: string) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['brandora-password-reset-otp-v1', email, otp]))
    .digest('hex');
}
