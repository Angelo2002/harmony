import type { DatabaseSync } from 'node:sqlite';
import type { Invite } from '@harmony/shared';

export interface InviteRow {
  code: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
}

export function toInvite(row: InviteRow): Invite {
  return {
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    uses: row.uses,
  };
}

export function insertInvite(
  sqlite: DatabaseSync,
  input: { code: string; createdBy: string; createdAt: string; expiresAt: string | null; maxUses: number | null },
): void {
  sqlite
    .prepare(
      `INSERT INTO invites (code, created_by, created_at, expires_at, max_uses, uses)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(input.code, input.createdBy, input.createdAt, input.expiresAt, input.maxUses);
}

export function findInvite(sqlite: DatabaseSync, code: string): InviteRow | null {
  return (sqlite.prepare('SELECT * FROM invites WHERE code = ?').get(code) as InviteRow | undefined) ?? null;
}

export function incrementInviteUses(sqlite: DatabaseSync, code: string): void {
  sqlite.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
}

export function listInvites(sqlite: DatabaseSync): InviteRow[] {
  return sqlite.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as unknown as InviteRow[];
}

export function deleteInvite(sqlite: DatabaseSync, code: string): void {
  sqlite.prepare('DELETE FROM invites WHERE code = ?').run(code);
}
