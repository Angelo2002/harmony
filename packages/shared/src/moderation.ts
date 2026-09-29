import type { User } from './types.ts';

/** Longest timeout an administrator may set, matching Discord's 28-day cap. */
export const TIMEOUT_MAX_MINUTES = 28 * 24 * 60;

/**
 * Whether a user is currently in a timeout. A timeout never removes read access;
 * it only stops the user from posting, reacting and uploading.
 */
export function isTimedOut(user: Pick<User, 'timedOutUntil'>, now: number = Date.now()): boolean {
  return user.timedOutUntil != null && new Date(user.timedOutUntil).getTime() > now;
}
