/**
 * True only when the database URL points at this computer (localhost).
 * Used to keep dev-only tools (the dev endpoint, the seed) away from any
 * shared or production database, even if a flag is switched on by mistake.
 */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
