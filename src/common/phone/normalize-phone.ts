/**
 * Normalizes a phone number to digits-only international format
 * (the same shape as WhatsApp's `wa_id`, e.g. "201000000001").
 *
 * Accepts "+20 100 000 0001", "0020-100-000-0001" and "201000000001".
 * Returns null for anything that is not 8-15 digits starting with 1-9
 * (E.164 allows at most 15 digits). Local formats such as "01000000001"
 * are rejected on purpose: without a country code we would be guessing.
 */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const digits = compact.startsWith('+')
    ? compact.slice(1)
    : compact.replace(/^00/, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
