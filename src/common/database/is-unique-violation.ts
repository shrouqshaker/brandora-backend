/**
 * True for Prisma's "unique constraint failed" error (P2002).
 * Used where two requests can race to insert the same unique value.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
