import type { DatabaseSync } from 'node:sqlite';
import type { Attachment } from '@harmony/shared';

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
  };
}

export function insertAttachment(
  sqlite: DatabaseSync,
  input: {
    id: string;
    uploaderId: string;
    filename: string;
    contentType: string;
    size: number;
    width: number | null;
    height: number | null;
    hash: string;
    createdAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO attachments (id, uploader_id, filename, content_type, size, width, height, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** Every blob hash still referenced by an attachment, an emoji or an avatar. */
export function listReferencedHashes(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite
    .prepare(
      `SELECT hash FROM attachments
       UNION SELECT hash FROM emojis
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
