import type { DatabaseSync } from 'node:sqlite';
import type { Emoji } from '@harmony/shared';

export interface EmojiRow {
  id: string;
  name: string;
  hash: string;
  content_type: string;
  animated: number;
  created_by: string | null;
  created_at: string;
  /** The Discord emoji this was learned from, or null for a native one. */
  discord_id: string | null;
}

export function toEmoji(row: EmojiRow): Emoji {
  return {
    id: row.id,
    name: row.name,
    hash: row.hash,
    animated: row.animated === 1,
    external: row.discord_id !== null,
  };
}

export function listEmojis(sqlite: DatabaseSync): EmojiRow[] {
  return sqlite.prepare('SELECT * FROM emojis ORDER BY name').all() as unknown as EmojiRow[];
}

export function findEmoji(sqlite: DatabaseSync, id: string): EmojiRow | null {
  return (sqlite.prepare('SELECT * FROM emojis WHERE id = ?').get(id) as EmojiRow | undefined) ?? null;
}

export function findEmojiByName(sqlite: DatabaseSync, name: string): EmojiRow | null {
  return (sqlite.prepare('SELECT * FROM emojis WHERE name = ?').get(name) as EmojiRow | undefined) ?? null;
}

/** The emoji learned from a Discord emoji id, or null when it is not here yet. */
export function findEmojiByDiscordId(sqlite: DatabaseSync, discordId: string): EmojiRow | null {
  return (
    (sqlite.prepare('SELECT * FROM emojis WHERE discord_id = ?').get(discordId) as EmojiRow | undefined) ?? null
  );
}

export function insertEmoji(
  sqlite: DatabaseSync,
  input: {
    id: string;
    name: string;
    hash: string;
    contentType: string;
    animated: boolean;
    createdBy: string | null;
    createdAt: string;
    /** Set only for an emoji learned from Discord. */
    discordId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO emojis (id, name, hash, content_type, animated, created_by, created_at, discord_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.hash,
      input.contentType,
      input.animated ? 1 : 0,
      input.createdBy,
      input.createdAt,
      input.discordId ?? null,
    );
}

export function deleteEmoji(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM emojis WHERE id = ?').run(id);
}
