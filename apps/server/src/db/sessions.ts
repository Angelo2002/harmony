import type { DatabaseSync } from 'node:sqlite';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string | null;
}

export function insertSession(
  sqlite: DatabaseSync,
  input: { id: string; userId: string; tokenHash: string; userAgent: string | null; createdAt: string; expiresAt: string | null },
): void {
  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.userId, input.tokenHash, input.userAgent, input.createdAt, input.createdAt, input.expiresAt);
}

export function findSessionByTokenHash(sqlite: DatabaseSync, tokenHash: string): SessionRow | null {
  return (sqlite.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined) ?? null;
}

export function touchSession(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function deleteSessionById(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteSessionByTokenHash(sqlite: DatabaseSync, tokenHash: string): void {
  sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/** Ends every session a user has, e.g. when they are kicked or banned. */
export function deleteSessionsForUser(sqlite: DatabaseSync, userId: string): number {
  const result = sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(result.changes);
}
