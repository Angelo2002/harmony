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
  discord_id: string | null;
  timed_out_until: string | null;
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
    timedOutUntil: row.timed_out_until,
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
  // Banned users are no longer members, so they are left out of every roster.
  return sqlite
    .prepare('SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM bans) ORDER BY created_at')
    .all() as unknown as UserRow[];
}

export function setUserTimeout(sqlite: DatabaseSync, userId: string, until: string | null): void {
  sqlite.prepare('UPDATE users SET timed_out_until = ? WHERE id = ?').run(until, userId);
}

export function findUserByDiscordId(sqlite: DatabaseSync, discordId: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as UserRow | undefined) ?? null;
}

export function updateUserProfile(
  sqlite: DatabaseSync,
  id: string,
  patch: { displayName?: string | null; avatarHash?: string | null },
): void {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (patch.avatarHash !== undefined) {
    sets.push('avatar_hash = ?');
    values.push(patch.avatarHash);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Creates a stand-in account for someone who only exists on the Discord side of
 * a bridge. It has no usable password, so it can never be logged into.
 */
export function insertGhostUser(
  sqlite: DatabaseSync,
  input: { id: string; username: string; displayName: string; discordId: string; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, is_bot, is_owner, created_at, discord_id)
       VALUES (?, ?, ?, '!no-password', 1, 0, ?, ?)`,
    )
    .run(input.id, input.username, input.displayName, input.createdAt, input.discordId);
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
