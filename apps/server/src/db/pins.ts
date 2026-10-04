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

/** How an atomic, cap-checked pin ended. */
export type PinResult = 'pinned' | 'already' | 'full';

/**
 * Pins a message only while its channel is under `cap`.
 *
 * The count and the update are a single statement, so two callers racing for the
 * last slot cannot both win one: SQLite evaluates the subquery and applies the
 * row change together, and the loser sees the channel already at the cap. The
 * return tells the caller which case it hit, so an already-pinned message stays a
 * quiet no-op while a full channel can be reported distinctly.
 */
export function setPinnedWithinCap(
  sqlite: DatabaseSync,
  messageId: string,
  pinnedBy: string | null,
  pinnedAt: string,
  channelId: string,
  cap: number,
): PinResult {
  const result = sqlite
    .prepare(
      `UPDATE messages SET pinned_at = ?, pinned_by = ?
        WHERE id = ? AND channel_id = ? AND pinned_at IS NULL
          AND (SELECT COUNT(*) FROM messages
                WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL) < ?`,
    )
    .run(pinnedAt, pinnedBy, messageId, channelId, channelId, cap);
  if (Number(result.changes) > 0) return 'pinned';

  // The update did not land, so say why: pinned already, or no room left. A row
  // that vanished under us reads as `already`, which the callers treat as a no-op.
  const row = sqlite.prepare('SELECT pinned_at FROM messages WHERE id = ?').get(messageId) as
    | { pinned_at: string | null }
    | undefined;
  return row && row.pinned_at === null ? 'full' : 'already';
}

/** Unpins a message. Returns false when it was not pinned. */
export function clearPinned(sqlite: DatabaseSync, messageId: string): boolean {
  const result = sqlite
    .prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ? AND pinned_at IS NOT NULL')
    .run(messageId);
  return Number(result.changes) > 0;
}
