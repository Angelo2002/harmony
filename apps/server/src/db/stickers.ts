import type { DatabaseSync } from 'node:sqlite';
import type { Sticker } from '@harmony/shared';

export interface StickerRow {
  id: string;
  discord_sticker_id: string;
  name: string;
  hash: string;
  content_type: string;
  animated: number;
  created_at: string;
  used_at: string;
}

export function toSticker(row: StickerRow): Sticker {
  return {
    id: row.id,
    name: row.name,
    hash: row.hash,
    animated: row.animated === 1,
  };
}

export function findSticker(sqlite: DatabaseSync, id: string): StickerRow | null {
  return (sqlite.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined) ?? null;
}

/** The sticker learned from a Discord sticker id, or null when it is not here. */
export function findStickerByDiscordId(sqlite: DatabaseSync, discordStickerId: string): StickerRow | null {
  return (
    (sqlite.prepare('SELECT * FROM stickers WHERE discord_sticker_id = ?').get(discordStickerId) as
      | StickerRow
      | undefined) ?? null
  );
}

export function insertSticker(
  sqlite: DatabaseSync,
  input: {
    id: string;
    discordStickerId: string;
    name: string;
    hash: string;
    contentType: string;
    animated: boolean;
    createdAt: string;
    usedAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO stickers
         (id, discord_sticker_id, name, hash, content_type, animated, created_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.discordStickerId,
      input.name,
      input.hash,
      input.contentType,
      input.animated ? 1 : 0,
      input.createdAt,
      input.usedAt,
    );
}

/** Moves a sticker forward, so seeing it again counts as using it. */
export function touchStickerUsed(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('UPDATE stickers SET used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/** Stickers not seen since `before`, for the retention rule. */
export function deleteStickersUnusedBefore(sqlite: DatabaseSync, before: string): number {
  const result = sqlite.prepare('DELETE FROM stickers WHERE used_at < ?').run(before);
  return Number(result.changes);
}

export function attachStickerToMessage(
  sqlite: DatabaseSync,
  messageId: string,
  stickerId: string,
  position: number,
): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO message_stickers (message_id, sticker_id, position)
       VALUES (?, ?, ?)`,
    )
    .run(messageId, stickerId, position);
}

/** Loads the stickers on several messages at once, keyed by message id. */
export function listStickersForMessages(sqlite: DatabaseSync, messageIds: string[]): Map<string, Sticker[]> {
  const result = new Map<string, Sticker[]>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT s.*, ms.message_id AS message_id
         FROM message_stickers ms
         JOIN stickers s ON s.id = ms.sticker_id
        WHERE ms.message_id IN (${placeholders})
        ORDER BY ms.position, s.id`,
    )
    .all(...messageIds) as unknown as Array<StickerRow & { message_id: string }>;

  for (const row of rows) {
    const list = result.get(row.message_id) ?? [];
    list.push(toSticker(row));
    result.set(row.message_id, list);
  }
  return result;
}
