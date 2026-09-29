import type { DatabaseSync } from 'node:sqlite';

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export function insertMessage(
  sqlite: DatabaseSync,
  input: { id: string; channelId: string; authorId: string; content: string; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, channel_id, author_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.channelId, input.authorId, input.content, input.createdAt);
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
