import type { DatabaseSync } from 'node:sqlite';

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
}

export function insertMessage(
  sqlite: DatabaseSync,
  input: {
    id: string;
    channelId: string;
    authorId: string;
    content: string;
    createdAt: string;
    replyToId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.channelId, input.authorId, input.content, input.createdAt, input.replyToId ?? null);
}

export function findMessage(sqlite: DatabaseSync, id: string): MessageRow | null {
  return (sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) ?? null;
}

/**
 * Returns the newest `limit` messages for a channel in ascending order.
 * `rowid` breaks ties so messages sent within the same millisecond keep order.
 */
export function listMessages(
  sqlite: DatabaseSync,
  channelId: string,
  options: { limit: number; before?: string },
): MessageRow[] {
  const rows = options.before
    ? sqlite
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(channelId, options.before, options.limit)
    : sqlite
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(channelId, options.limit);

  return (rows as unknown as MessageRow[]).reverse();
}

export function updateMessageContent(sqlite: DatabaseSync, id: string, content: string, editedAt: string): void {
  sqlite.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, id);
}

export function softDeleteMessage(sqlite: DatabaseSync, id: string, deletedAt: string): void {
  sqlite.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
}

export function countMessages(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
  return row.count;
}

/** Retention removes rows outright; attachments cascade via their foreign key. */
export function deleteMessagesOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite.prepare('DELETE FROM messages WHERE created_at < ?').run(before);
  return Number(result.changes);
}

export function deleteOldestMessages(sqlite: DatabaseSync, limit: number): number {
  const result = sqlite
    .prepare('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at, rowid LIMIT ?)')
    .run(limit);
  return Number(result.changes);
}
