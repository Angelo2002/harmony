import type { DatabaseSync } from 'node:sqlite';
import { Permission, hasPermission, isTimedOut, type PermissionValue } from '@harmony/shared';
import type { UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { resolvePermissions } from './permissions.ts';
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

/**
 * Anti-escalation guard: without Administrator you cannot hand out, take away
 * or reshape a permission you do not hold yourself. Applies to role edits as
 * well as to giving a role to someone, yourself included.
 */
export function assertCanGrant(auth: AuthContext, permissions: PermissionValue): void {
  if (hasPermission(auth.permissions, Permission.Administrator)) return;
  if ((permissions & ~auth.permissions) !== 0n) {
    throw new HttpError(403, 'permission_escalation', 'You cannot grant permissions you do not have.');
  }
}

/**
 * Administrators (the owner included) can only be acted on by another
 * administrator, the same rule moderation already follows. Without it, a
 * delegated permission such as Manage Members would quietly mean "can become
 * the owner".
 */
export function assertCanActOn(sqlite: DatabaseSync, auth: AuthContext, target: UserRow): void {
  if (hasPermission(auth.permissions, Permission.Administrator)) return;
  if (hasPermission(resolvePermissions(sqlite, target), Permission.Administrator)) {
    throw new HttpError(403, 'target_is_admin', 'Only an administrator can change an administrator.');
  }
}
