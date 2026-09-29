import type { DatabaseSync } from 'node:sqlite';
import { permissionsFromString, type PermissionValue, type Role } from '@harmony/shared';

export interface RoleRow {
  id: string;
  name: string;
  color: number | null;
  position: number;
  permissions: string;
  hoist: number;
  mentionable: number;
  is_default: number;
  created_at: string;
}

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    permissions: row.permissions,
    hoist: row.hoist === 1,
    mentionable: row.mentionable === 1,
    isDefault: row.is_default === 1,
  };
}

/** Highest position first, matching how the admin panel lists roles. */
export function listRoles(sqlite: DatabaseSync): RoleRow[] {
  return sqlite.prepare('SELECT * FROM roles ORDER BY position DESC, name').all() as unknown as RoleRow[];
}

export function findRole(sqlite: DatabaseSync, id: string): RoleRow | null {
  return (sqlite.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined) ?? null;
}

export function nextRolePosition(sqlite: DatabaseSync): number {
  const row = sqlite
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM roles')
    .get() as { position: number };
  return row.position;
}

export function insertRole(
  sqlite: DatabaseSync,
  input: {
    id: string;
    name: string;
    color: number | null;
    position: number;
    permissions: string;
    hoist: boolean;
    mentionable: boolean;
    createdAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO roles (id, name, color, position, permissions, hoist, mentionable, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.color,
      input.position,
      input.permissions,
      input.hoist ? 1 : 0,
      input.mentionable ? 1 : 0,
      input.createdAt,
    );
}

export function updateRole(
  sqlite: DatabaseSync,
  id: string,
  patch: { name?: string; color?: number | null; position?: number; permissions?: string; hoist?: boolean; mentionable?: boolean },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    values.push(patch.color);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (patch.permissions !== undefined) {
    sets.push('permissions = ?');
    values.push(patch.permissions);
  }
  if (patch.hoist !== undefined) {
    sets.push('hoist = ?');
    values.push(patch.hoist ? 1 : 0);
  }
  if (patch.mentionable !== undefined) {
    sets.push('mentionable = ?');
    values.push(patch.mentionable ? 1 : 0);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRole(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM roles WHERE id = ?').run(id);
}

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

export function listRoleIdsForUser(sqlite: DatabaseSync, userId: string): string[] {
  const rows = sqlite
    .prepare('SELECT role_id FROM member_roles WHERE user_id = ?')
    .all(userId) as unknown as Array<{ role_id: string }>;
  return rows.map((row) => row.role_id);
}

/** All member-role assignments, grouped by user id, in one query. */
export function listMemberRoles(sqlite: DatabaseSync): Map<string, string[]> {
  const rows = sqlite
    .prepare('SELECT user_id, role_id FROM member_roles')
    .all() as unknown as Array<{ user_id: string; role_id: string }>;

  const result = new Map<string, string[]>();
  for (const row of rows) {
    const list = result.get(row.user_id) ?? [];
    list.push(row.role_id);
    result.set(row.user_id, list);
  }
  return result;
}

export function assignRole(sqlite: DatabaseSync, userId: string, roleId: string): void {
  sqlite.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleId);
}

export function unassignRole(sqlite: DatabaseSync, userId: string, roleId: string): void {
  sqlite.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId);
}
