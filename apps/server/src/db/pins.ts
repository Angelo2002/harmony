import type { DatabaseSync } from 'node:sqlite';
import type { MessageRow } from './messages.ts';

/*
 * Pins live on the message row itself (`pinned_at`, `pinned_by`, migration 23),
 * so these are the few queries that read and write just those columns. A
 * soft-deleted message is never counted or listed, which is how a deleted pin
 * drops out without anything having to clear it.
 */

/** A channel's live pins, newest pin first. */
export function listPinnedMessages(sqlite: DatabaseSync, channelId: string): MessageRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL
       ORDER BY pinned_at DESC, rowid DESC`,
    )
    .all(channelId) as unknown as MessageRow[];
}

/** How many live pins a channel holds, for the per-channel cap. */
export function countPinnedMessages(sqlite: DatabaseSync, channelId: string): number {
  const row = sqlite
    .prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL',
    )
    .get(channelId) as { count: number };
  return row.count;
}

/** Pins a message. Returns false when it was already pinned, leaving the original time. */
export function setPinned(sqlite: DatabaseSync, messageId: string, pinnedBy: string | null, pinnedAt: string): boolean {
  const result = sqlite
    .prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ? AND pinned_at IS NULL')
    .run(pinnedAt, pinnedBy, messageId);
  return Number(result.changes) > 0;
}

/** Unpins a message. Returns false when it was not pinned. */
export function clearPinned(sqlite: DatabaseSync, messageId: string): boolean {
  const result = sqlite
    .prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ? AND pinned_at IS NOT NULL')
    .run(messageId);
  return Number(result.changes) > 0;
}
