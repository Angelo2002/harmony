import type { DatabaseSync } from 'node:sqlite';

export interface BanRow {
  user_id: string;
  banned_by: string | null;
  reason: string | null;
  created_at: string;
}

/** Records a ban, replacing any existing one for the same user. */
export function insertBan(
  sqlite: DatabaseSync,
  input: { userId: string; bannedBy: string; reason: string | null; createdAt: string },
): void {
  sqlite
    .prepare('INSERT OR REPLACE INTO bans (user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(input.userId, input.bannedBy, input.reason, input.createdAt);
}

export function findBan(sqlite: DatabaseSync, userId: string): BanRow | null {
  return (sqlite.prepare('SELECT * FROM bans WHERE user_id = ?').get(userId) as BanRow | undefined) ?? null;
}

/** Returns true when a ban was actually lifted. */
export function deleteBan(sqlite: DatabaseSync, userId: string): boolean {
  const result = sqlite.prepare('DELETE FROM bans WHERE user_id = ?').run(userId);
  return Number(result.changes) > 0;
}

export function listBans(sqlite: DatabaseSync): BanRow[] {
  return sqlite.prepare('SELECT * FROM bans ORDER BY created_at DESC').all() as unknown as BanRow[];
}
