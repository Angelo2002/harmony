import type { ZodType } from 'zod';
import { HttpError } from './errors.ts';

function parse<T>(schema: ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => `${issue.path.join('.') || source}: ${issue.message}`)
    .join('; ');
  throw new HttpError(400, 'validation_error', message);
}

/** Parses and validates a request body. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  return parse(schema, body, 'body');
}

/** Parses and validates query string parameters (values arrive as strings). */
export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  return parse(schema, query, 'query');
}
