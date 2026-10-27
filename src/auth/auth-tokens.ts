import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { isUUID } from 'class-validator';

export function opaqueToken(locator: string = randomUUID()) {
  const value = `${locator}.${randomBytes(32).toString('base64url')}`;
  return { value, locator, hash: tokenHash(value) };
}
export function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function tokenLocator(value: string): string | null {
  if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const locator = value.slice(0, 36);
  return isUUID(locator, '4') ? locator : null;
}
export function equalHash(a: string, b: string) {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}
