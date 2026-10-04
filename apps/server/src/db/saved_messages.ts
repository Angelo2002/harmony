import type { DatabaseSync } from 'node:sqlite';
import type { MessageRow } from './messages.ts';

/** A message row carrying the save that put it in someone's list. */
export interface SavedMessageRow extends MessageRow {
  saved_at: string;
  remind_at: string | null;
}

/**
 * Saves a message for a member. Saving one already saved keeps its original
 * time, so it does not jump to the top of the list; `remindAt` replaces the
 * reminder when given (null clears it) and leaves it alone when undefined.
 * Returns whether anything changed, so a repeat save stays quiet.
 */
export function saveMessage(
  sqlite: DatabaseSync,
  input: { userId: string; messageId: string; savedAt: string; remindAt?: string | null },
): boolean {
  const existing = findSavedMessage(sqlite, input.userId, input.messageId);
  if (!existing) {
    sqlite
      .prepare('INSERT INTO saved_messages (user_id, message_id, saved_at, remind_at) VALUES (?, ?, ?, ?)')
      .run(input.userId, input.messageId, input.savedAt, input.remindAt ?? null);
    return true;
  }
  if (input.remindAt === undefined || input.remindAt === existing.remind_at) return false;
  sqlite
    .prepare('UPDATE saved_messages SET remind_at = ? WHERE user_id = ? AND message_id = ?')
    .run(input.remindAt, input.userId, input.messageId);
  return true;
}

/** Forgets a save. Returns false when there was none. */
export function unsaveMessage(sqlite: DatabaseSync, userId: string, messageId: string): boolean {
  const result = sqlite
    .prepare('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?')
    .run(userId, messageId);
  return Number(result.changes) > 0;
}

export function findSavedMessage(
  sqlite: DatabaseSync,
  userId: string,
  messageId: string,
): { saved_at: string; remind_at: string | null } | null {
  const row = sqlite
    .prepare('SELECT saved_at, remind_at FROM saved_messages WHERE user_id = ? AND message_id = ?')
    .get(userId, messageId) as { saved_at: string; remind_at: string | null } | undefined;
  return row ?? null;
}

/**
 * Which of these messages the member has saved, for the `saved` flag on a page
 * of messages. One query per page, the same as the reactions beside it.
 */
export function listSavedAmong(sqlite: DatabaseSync, userId: string, messageIds: string[]): Set<string> {
  if (!userId || messageIds.length === 0) return new Set();
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(`SELECT message_id FROM saved_messages WHERE user_id = ? AND message_id IN (${placeholders})`)
    .all(userId, ...messageIds) as unknown as Array<{ message_id: string }>;
  return new Set(rows.map((row) => row.message_id));
}

/**
 * A member's saved messages, newest save first. Only the channels they may see
 * are asked about and deleted messages are skipped, so a save they can no longer
 * read drops out of the list without the row being touched: should the channel
 * open up to them again, it comes back. The cursor is a save time plus the
 * message id, since two saves can share a millisecond.
 */
export function listSavedMessages(
  sqlite: DatabaseSync,
  userId: string,
  channelIds: string[],
  options: { limit: number; before?: string | undefined; beforeId?: string | undefined },
): SavedMessageRow[] {
  if (channelIds.length === 0) return [];
  const { limit, before, beforeId } = options;

  const placeholders = channelIds.map(() => '?').join(', ');
  const conditions = ['s.user_id = ?', 'm.deleted_at IS NULL', `m.channel_id IN (${placeholders})`];
  const values: Array<string | number> = [userId, ...channelIds];

  if (before !== undefined && beforeId !== undefined) {
    conditions.push('(s.saved_at < ? OR (s.saved_at = ? AND s.message_id < ?))');
    values.push(before, before, beforeId);
  } else if (before !== undefined) {
    conditions.push('s.saved_at < ?');
    values.push(before);
  }

  values.push(limit);
  return sqlite
    .prepare(
      `SELECT m.*, s.saved_at, s.remind_at
         FROM saved_messages s
         JOIN messages m ON m.id = s.message_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.saved_at DESC, s.message_id DESC
        LIMIT ?`,
    )
    .all(...values) as unknown as SavedMessageRow[];
}

/**
 * The saves carrying a reminder, soonest first, under the same visibility rules
 * as the list. A client reads this to know when to remind; one that has already
 * come due stays here until it is cleared or the save is removed.
 */
export function listSavedReminders(
  sqlite: DatabaseSync,
  userId: string,
  channelIds: string[],
  limit: number,
): SavedMessageRow[] {
  if (channelIds.length === 0) return [];
  const placeholders = channelIds.map(() => '?').join(', ');
  return sqlite
    .prepare(
      `SELECT m.*, s.saved_at, s.remind_at
         FROM saved_messages s
         JOIN messages m ON m.id = s.message_id
        WHERE s.user_id = ? AND s.remind_at IS NOT NULL
          AND m.deleted_at IS NULL AND m.channel_id IN (${placeholders})
        ORDER BY s.remind_at ASC, s.message_id ASC
        LIMIT ?`,
    )
    .all(userId, ...channelIds, limit) as unknown as SavedMessageRow[];
}
