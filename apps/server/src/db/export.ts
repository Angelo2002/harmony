import type { DatabaseSync } from 'node:sqlite';
import type { MessageRow } from './messages.ts';

/** A message row with the `rowid` the export pages by. */
export interface ExportMessageRow extends MessageRow {
  row: number;
}

/**
 * One page of a channel's history, oldest first, for an export.
 *
 * The cursor is the last row already written: its `created_at` plus its rowid.
 * Ordering by time rather than by rowid alone matters because a bridge backfill
 * inserts old messages late, and the rowid breaks ties within a millisecond the
 * same way the history reader does. Deleted messages are left out, as they are
 * from the channel itself.
 */
export function listMessagesForExport(
  sqlite: DatabaseSync,
  channelId: string,
  options: { limit: number; after?: { createdAt: string; row: number } },
): ExportMessageRow[] {
  const { limit, after } = options;
  const rows = after
    ? sqlite
        .prepare(
          `SELECT rowid AS row, * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL
             AND (created_at > ? OR (created_at = ? AND rowid > ?))
           ORDER BY created_at, rowid LIMIT ?`,
        )
        .all(channelId, after.createdAt, after.createdAt, after.row, limit)
    : sqlite
        .prepare(
          `SELECT rowid AS row, * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL
           ORDER BY created_at, rowid LIMIT ?`,
        )
        .all(channelId, limit);
  return rows as unknown as ExportMessageRow[];
}
