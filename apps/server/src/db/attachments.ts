import type { DatabaseSync } from 'node:sqlite';
import { GIF_CONTENT_TYPES, type Attachment } from '@harmony/shared';

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  uploader_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  created_at: string;
  /** The link this was copied from, or null for something that was uploaded. */
  source_url: string | null;
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    hash: row.hash,
    createdAt: row.created_at,
    sourceUrl: row.source_url,
  };
}

export function insertAttachment(
  sqlite: DatabaseSync,
  input: {
    id: string;
    uploaderId: string | null;
    filename: string;
    contentType: string;
    size: number;
    width: number | null;
    height: number | null;
    hash: string;
    createdAt: string;
    /** Set when the bytes came from a link rather than an upload. */
    sourceUrl?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO attachments (id, uploader_id, filename, content_type, size, width, height, hash, created_at, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.uploaderId,
      input.filename,
      input.contentType,
      input.size,
      input.width,
      input.height,
      input.hash,
      input.createdAt,
      input.sourceUrl ?? null,
    );
}

/**
 * The attachments on a message that were copied from a link, so the one keeping
 * a message in step with its own text can be found again.
 */
export function listLinkedAttachments(sqlite: DatabaseSync, messageId: string): AttachmentRow[] {
  return sqlite
    .prepare('SELECT * FROM attachments WHERE message_id = ? AND source_url IS NOT NULL')
    .all(messageId) as unknown as AttachmentRow[];
}

/**
 * Something already copied from this link, newest first, whoever posted it. Used
 * to avoid fetching a file this instance is already holding: the same gif comes
 * round again far more often than a community finds a new one.
 */
export function findAttachmentBySourceUrl(sqlite: DatabaseSync, url: string): AttachmentRow | null {
  return (
    (sqlite
      .prepare('SELECT * FROM attachments WHERE source_url = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(url) as AttachmentRow | undefined) ?? null
  );
}

export function findAttachment(sqlite: DatabaseSync, id: string): AttachmentRow | null {
  return (sqlite.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined) ?? null;
}

export function attachToMessage(sqlite: DatabaseSync, attachmentId: string, messageId: string): void {
  sqlite.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(messageId, attachmentId);
}

export function countAttachments(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM attachments').get() as { count: number };
  return row.count;
}

/**
 * Every blob hash still referenced by an attachment, an emoji, an avatar or a
 * saved gif. A favorite is here on purpose: it is kept by hash rather than by a
 * message, so it is what keeps a saved gif alive after the message it was found
 * in is gone.
 */
export function listReferencedHashes(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite
    .prepare(
      `SELECT hash FROM attachments
       UNION SELECT hash FROM emojis
       UNION SELECT hash FROM gif_favorites
       UNION SELECT avatar_hash FROM users WHERE avatar_hash IS NOT NULL`,
    )
    .all() as unknown as Array<{ hash: string }>;
  const hashes = new Set(rows.map((row) => row.hash));

  // The instance icon is a blob too, but its hash lives in the settings table
  // rather than a column, so it has to be added by hand or the sweep would
  // delete it. The key matches `KEY_ICON_HASH` in the settings service.
  const icon = sqlite.prepare("SELECT value FROM server_settings WHERE key = 'instance_icon_hash'").get() as
    | { value: string }
    | undefined;
  if (icon) {
    try {
      const parsed: unknown = JSON.parse(icon.value);
      if (typeof parsed === 'string' && parsed.length > 0) hashes.add(parsed);
    } catch {
      // A malformed stored value simply contributes no reference.
    }
  }

  return hashes;
}

/** Deletes image rows only; callers sweep the blobs afterwards. */
export function deleteImageAttachmentsOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite
    .prepare("DELETE FROM attachments WHERE created_at < ? AND content_type LIKE 'image/%'")
    .run(before);
  return Number(result.changes);
}

/** Deletes video rows only; callers sweep the blobs afterwards. */
export function deleteVideoAttachmentsOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite
    .prepare("DELETE FROM attachments WHERE created_at < ? AND content_type LIKE 'video/%'")
    .run(before);
  return Number(result.changes);
}

/** Uploads that were never attached to a message (abandoned drafts). */
export function deleteUnattachedAttachmentsOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite
    .prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?')
    .run(before);
  return Number(result.changes);
}

export function deleteOldestAttachments(sqlite: DatabaseSync, limit: number): number {
  const result = sqlite
    .prepare('DELETE FROM attachments WHERE id IN (SELECT id FROM attachments ORDER BY created_at, rowid LIMIT ?)')
    .run(limit);
  return Number(result.changes);
}

/** Loads attachments for several messages at once, keyed by message id. */
export function listAttachmentsForMessages(
  sqlite: DatabaseSync,
  messageIds: string[],
): Map<string, Attachment[]> {
  const result = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at, id`)
    .all(...messageIds) as unknown as AttachmentRow[];

  for (const row of rows) {
    if (!row.message_id) continue;
    const list = result.get(row.message_id) ?? [];
    list.push(toAttachment(row));
    result.set(row.message_id, list);
  }
  return result;
}

/** An attachment plus where it was posted, for the admin media gallery. */
export interface MediaRow extends AttachmentRow {
  channel_id: string | null;
  channel_name: string | null;
}

/**
 * A page of stored media, newest first, with the channel each attachment's
 * message belongs to. Abandoned uploads (no message yet) come back with null
 * channel fields. The cursor mirrors message history: timestamp plus id.
 */
export function listMedia(
  sqlite: DatabaseSync,
  options: { limit: number; before?: string; beforeId?: string },
): MediaRow[] {
  const { limit, before, beforeId } = options;
  const base = `SELECT a.*, m.channel_id AS channel_id, c.name AS channel_name
                FROM attachments a
                LEFT JOIN messages m ON m.id = a.message_id
                LEFT JOIN channels c ON c.id = m.channel_id`;

  const rows =
    before && beforeId
      ? sqlite
          .prepare(
            `${base}
             WHERE a.created_at < ?
                OR (a.created_at = ? AND a.rowid < (SELECT rowid FROM attachments WHERE id = ?))
             ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
          )
          .all(before, before, beforeId, limit)
      : before
        ? sqlite.prepare(`${base} WHERE a.created_at < ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`).all(before, limit)
        : sqlite.prepare(`${base} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`).all(limit);

  return rows as unknown as MediaRow[];
}

export function deleteAttachment(sqlite: DatabaseSync, id: string): boolean {
  const result = sqlite.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/**
 * Recent gif attachments that could appear in the picker's local tab, newest first.
 * `channelIds` limits it to the channels a member may see, and null means every
 * channel, which is what an administrator gets. `q` matches the file name or the
 * link it was fetched from. Rows are not deduplicated: the same bytes are stored
 * once but sent many times, and which copy to keep is the caller's call.
 */
export function listRecentGifAttachments(
  sqlite: DatabaseSync,
  options: { channelIds: string[] | null; q: string | null; limit: number },
): AttachmentRow[] {
  if (options.channelIds && options.channelIds.length === 0) return [];

  const types = GIF_CONTENT_TYPES.map(() => '?').join(', ');
  const clauses = [`a.content_type IN (${types})`, 'a.message_id IS NOT NULL'];
  const params: Array<string | number> = [...GIF_CONTENT_TYPES];

  if (options.channelIds) {
    clauses.push(`m.channel_id IN (${options.channelIds.map(() => '?').join(', ')})`);
    params.push(...options.channelIds);
  }
  if (options.q) {
    // A search term is text, not a pattern, so its own wildcards are escaped.
    const like = `%${options.q.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push("(a.filename LIKE ? ESCAPE '\\' OR a.source_url LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  params.push(options.limit);

  return sqlite
    .prepare(
      `SELECT a.* FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY a.created_at DESC, a.rowid DESC
       LIMIT ?`,
    )
    .all(...params) as unknown as AttachmentRow[];
}
