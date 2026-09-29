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
