import type { DatabaseSync } from 'node:sqlite';
import {
  Permission,
  hasPermission,
  isTimedOut,
  permissionsFromString,
  type PermissionValue,
} from '@harmony/shared';
import { roleControlsAccess, type RoleRow } from '../db/roles.ts';
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

/**
 * The "may manage this role" rule, for handing a role out or deleting it.
 *
 * The permission-subset guard alone is not enough here. A role with no
 * permissions of its own - the pure-membership roles used to gate a locked
 * channel - is a subset of everyone, so `assertCanGrant` passes for any caller.
 * But a role a channel or category requires controls read access: assigning it
 * to yourself opens that channel, and deleting it clears the requirement (the
 * foreign keys are `ON DELETE SET NULL`) and opens it to everyone. Managing such
 * a role is a channel-management act, so it needs ManageChannels, not merely
 * ManageRoles.
 *
 * Cosmetic, low-permission roles stay delegable: they control nothing until an
 * administrator points a channel at them.
 */
export function assertCanManageRole(sqlite: DatabaseSync, auth: AuthContext, role: RoleRow): void {
  assertCanGrant(auth, permissionsFromString(role.permissions));
  if (hasPermission(auth.permissions, Permission.ManageChannels)) return;
  if (roleControlsAccess(sqlite, role.id)) {
    throw new HttpError(
      403,
      'access_role',
      'That role controls channel access, so managing it needs Manage Channels.',
    );
  }
}
