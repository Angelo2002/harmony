import type { DatabaseSync } from 'node:sqlite';
import type { User } from '@harmony/shared';
import { getHighestRoleColor } from './roles.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  avatar_hash: string | null;
  is_bot: number;
  is_owner: number;
  created_at: string;
}

export function toUser(row: UserRow, roleColor: number | null): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    roleColor,
    isBot: row.is_bot === 1,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  };
}

/** A user DTO with their display colour resolved from their roles. */
export function presentUser(sqlite: DatabaseSync, row: UserRow): User {
  return toUser(row, getHighestRoleColor(sqlite, row.id));
}

export function countUsers(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  return row.count;
}

export function findUserById(sqlite: DatabaseSync, id: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

export function findUserByUsername(sqlite: DatabaseSync, username: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined) ?? null;
}

export function listUsers(sqlite: DatabaseSync): UserRow[] {
  return sqlite.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[];
}

export function insertUser(
  sqlite: DatabaseSync,
  input: { id: string; username: string; passwordHash: string; isOwner: boolean },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.username, input.passwordHash, input.isOwner ? 1 : 0, new Date().toISOString());
}
