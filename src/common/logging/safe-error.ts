import { HttpException } from '@nestjs/common';

/**
 * A short description of an error for the logs: its kind and code only,
 * never its message. A message can repeat a customer's text (Prisma prints
 * the query arguments) or part of a secret.
 */
export function safeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === 'string' ? ` ${code}` : '';
  if (error instanceof HttpException) return `${error.getStatus()}${suffix}`;
  if (error instanceof Error) return `${error.name}${suffix}`;
  return 'unknown error';
}
