import type { DatabaseSync } from 'node:sqlite';

export interface AuditRow {
  id: string;
  kind: string;
  actor_id: string | null;
  target_id: string | null;
  channel_id: string | null;
  detail: string;
  created_at: string;
}

export function insertAudit(
  sqlite: DatabaseSync,
  input: {
    id: string;
    kind: string;
    actorId: string | null;
    targetId: string | null;
    channelId: string | null;
    detail: string;
    createdAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO audit_log (id, kind, actor_id, target_id, channel_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.kind, input.actorId, input.targetId, input.channelId, input.detail, input.createdAt);
}

/**
 * Newest entries first.
 *
 * Paging backwards takes the timestamp and id of the oldest entry already held.
 * The id matters because `created_at` only has millisecond precision, so a burst
 * of entries could otherwise share a timestamp and the rest would be skipped;
 * `rowid` ties them back to insertion order.
 */
export function listAudit(
  sqlite: DatabaseSync,
  options: { limit: number; before?: string; beforeId?: string },
): AuditRow[] {
  const { limit, before, beforeId } = options;

  const rows =
    before && beforeId
      ? sqlite
          .prepare(
            `SELECT * FROM audit_log
             WHERE created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM audit_log WHERE id = ?))
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(before, before, beforeId, limit)
      : before
        ? sqlite
            .prepare(
              `SELECT * FROM audit_log WHERE created_at < ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(before, limit)
        : sqlite.prepare('SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);

  return rows as unknown as AuditRow[];
}
