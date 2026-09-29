import type { ZodType } from 'zod';
import { HttpError } from './errors.ts';

/**
 * Parses a request body against a zod schema, turning the first failure into a
 * 400 with a readable, field-prefixed message.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  throw new HttpError(400, 'validation_error', message);
}
