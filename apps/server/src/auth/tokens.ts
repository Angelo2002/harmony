import { createHash, randomBytes } from 'node:crypto';

/** Generates an opaque, URL-safe session token (the raw value only ever lives client-side). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash of a token is stored, so a database leak cannot be replayed as a session. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
