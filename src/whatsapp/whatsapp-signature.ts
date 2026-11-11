import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 of
 * the exact bytes it sent, using the App secret. We compute the same thing.
 * Same result = the body came from Meta and nobody changed it.
 */
export function isValidWhatsAppSignature(
  rawBody: Buffer | undefined,
  header: unknown,
  appSecret: string,
): boolean {
  if (!rawBody || !appSecret || typeof header !== 'string') return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}