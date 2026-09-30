import type { DatabaseSync } from 'node:sqlite';
import type { EmbedPlayer, LinkEmbed } from '@harmony/shared';

/** YouTube video ids are 11 URL-safe characters; anything else is not offered. */
function parsePlayer(value: unknown): EmbedPlayer | null {
  if (!value || typeof value !== 'object') return null;
  const player = value as { provider?: unknown; id?: unknown };
  if (player.provider !== 'youtube') return null;
  if (typeof player.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(player.id)) return null;
  return { provider: 'youtube', id: player.id };
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  /** The unfurled link preview as JSON, or NULL. */
  embed: string | null;
}

/** Reads the stored embed JSON back into a preview, ignoring anything malformed. */
export function parseMessageEmbed(raw: string | null): LinkEmbed | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LinkEmbed>;
    if (typeof value.url !== 'string' || value.url.length === 0) return null;
    return {
      url: value.url,
      title: typeof value.title === 'string' ? value.title : null,
      description: typeof value.description === 'string' ? value.description : null,
      siteName: typeof value.siteName === 'string' ? value.siteName : null,
      imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : null,
      player: parsePlayer(value.player),
    };
  } catch {
    return null;
  }
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

export interface SearchOptions {
  /** The term to look for, as a literal substring. */
  query: string;
  /** Channel ids the searcher may see; an empty list finds nothing. */
  channelIds: string[];
  authorId?: string | undefined;
  limit: number;
  before?: string | undefined;
  beforeId?: string | undefined;
}

/** Escapes the LIKE wildcards so searching for `100%` means a literal `100%`. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Case-insensitive substring search over message text, newest first. Deleted
 * messages are left out, and a caller must pass the channels the searcher may
 * see, so locked channels can never leak through the results. Paging uses the
 * same `created_at` + id cursor as the history reader, for the same reason: a
 * burst of messages can share a millisecond.
 */
export function searchMessages(sqlite: DatabaseSync, options: SearchOptions): MessageRow[] {
  const { query, channelIds, authorId, limit, before, beforeId } = options;
  if (channelIds.length === 0 || query.length === 0) return [];

  const conditions = ['deleted_at IS NULL', "content LIKE ? ESCAPE '\\'"];
  const values: Array<string | number> = [likePattern(query)];

  conditions.push(`channel_id IN (${channelIds.map(() => '?').join(', ')})`);
  values.push(...channelIds);

  if (authorId !== undefined) {
    conditions.push('author_id = ?');
    values.push(authorId);
  }
  if (before !== undefined && beforeId !== undefined) {
    conditions.push('(created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)))');
    values.push(before, before, beforeId);
  } else if (before !== undefined) {
    conditions.push('created_at < ?');
    values.push(before);
  }

  values.push(limit);
  return sqlite
    .prepare(`SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...values) as unknown as MessageRow[];
}

/** When a member last posted in a channel, for slowmode. Deleted rows still count. */
export function lastMessageAt(sqlite: DatabaseSync, channelId: string, authorId: string): string | null {
  const row = sqlite
    .prepare(
      'SELECT created_at AS at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(channelId, authorId) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * Returns the newest `limit` messages for a channel in ascending order.
 *
 * Paging backwards takes a cursor of the oldest message you have: its
 * `createdAt` plus its id. The id matters because `created_at` only has
 * millisecond precision — a burst of messages (a bridge history import, say) can
 * share a timestamp, and a timestamp-only cursor would skip the rest of that
 * millisecond. `rowid` ties them back to insertion order.
 */
export function listMessages(
  sqlite: DatabaseSync,
  channelId: string,
  options: { limit: number; before?: string; beforeId?: string },
): MessageRow[] {
  const { limit, before, beforeId } = options;

  const rows =
    before && beforeId
      ? sqlite
          .prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND deleted_at IS NULL
               AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)))
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(channelId, before, before, beforeId, limit)
      : before
        ? sqlite
            .prepare(
              `SELECT * FROM messages
               WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(channelId, before, limit)
        : sqlite
            .prepare(
              `SELECT * FROM messages
               WHERE channel_id = ? AND deleted_at IS NULL
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(channelId, limit);

  return (rows as unknown as MessageRow[]).reverse();
}

export function updateMessageContent(sqlite: DatabaseSync, id: string, content: string, editedAt: string): void {
  // The old preview no longer matches the new text, so drop it here. The embed
  // service re-resolves the new content and broadcasts again when it finds a link.
  sqlite
    .prepare('UPDATE messages SET content = ?, edited_at = ?, embed = NULL WHERE id = ?')
    .run(content, editedAt, id);
}

/** Stores a message's unfurled preview JSON, or clears it when given null. */
export function setMessageEmbed(sqlite: DatabaseSync, id: string, embed: string | null): boolean {
  const result = sqlite.prepare('UPDATE messages SET embed = ? WHERE id = ?').run(embed, id);
  return Number(result.changes) > 0;
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
