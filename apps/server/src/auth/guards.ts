import { isTimedOut } from '@harmony/shared';
import { HttpError } from '../http/errors.ts';
import type { AuthContext } from './service.ts';

/**
 * Rejects an action from a member who is in a timeout. A timeout never removes
 * read access, so this is only used by the write paths (messages, reactions,
 * uploads).
 */
export function assertNotTimedOut(auth: AuthContext): void {
  if (!isTimedOut(auth.user)) return;
  throw new HttpError(403, 'timed_out', 'You are timed out and cannot post right now.');
}
