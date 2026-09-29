import type { DatabaseSync } from 'node:sqlite';
import { ALL_PERMISSIONS, type PermissionValue } from '@harmony/shared';
import { getDefaultRolePermissions, getUserRolePermissions } from '../db/roles.ts';
import type { UserRow } from '../db/users.ts';

/**
 * Effective permissions for a user: the instance owner implicitly has
 * everything; otherwise it is `@everyone` OR-ed with the user's roles.
 */
export function resolvePermissions(sqlite: DatabaseSync, user: UserRow): PermissionValue {
  if (user.is_owner === 1) return ALL_PERMISSIONS;
  return getDefaultRolePermissions(sqlite) | getUserRolePermissions(sqlite, user.id);
}
