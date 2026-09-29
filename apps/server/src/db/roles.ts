import type { DatabaseSync } from 'node:sqlite';
import { permissionsFromString, type PermissionValue } from '@harmony/shared';

/** Permissions granted to the implicit `@everyone` role. */
export function getDefaultRolePermissions(sqlite: DatabaseSync): PermissionValue {
  const row = sqlite.prepare('SELECT permissions FROM roles WHERE is_default = 1').get() as
    | { permissions: string }
    | undefined;
  return row ? permissionsFromString(row.permissions) : 0n;
}

/** Union of every role explicitly assigned to the user. */
export function getUserRolePermissions(sqlite: DatabaseSync, userId: string): PermissionValue {
  const rows = sqlite
    .prepare(
      `SELECT r.permissions AS permissions
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.user_id = ?`,
    )
    .all(userId) as Array<{ permissions: string }>;

  return rows.reduce<PermissionValue>((acc, row) => acc | permissionsFromString(row.permissions), 0n);
}
