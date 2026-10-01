import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GifFavorite } from '@harmony/shared';

export interface GifFavoriteRow {
  id: string;
  user_id: string;
  hash: string;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  source_url: string | null;
  created_at: string;
  used_at: string;
}

export function toGifFavorite(row: GifFavoriteRow): GifFavorite {
  return {
    id: row.id,
    hash: row.hash,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    usedAt: row.used_at,
  };
}

export interface GifFavoriteInput {
  userId: string;
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
}

/**
 * Keeps a gif, or bumps the one already kept. Favouriting the same gif twice is
 * the same gif, so a repeat only moves `used_at` forward — which is exactly what
 * the retention rule for favourites counts from.
 */
export function upsertGifFavorite(sqlite: DatabaseSync, input: GifFavoriteInput): GifFavoriteRow {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO gif_favorites
         (id, user_id, hash, filename, content_type, size, width, height, source_url, created_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, hash) DO UPDATE SET used_at = excluded.used_at`,
    )
    .run(
      randomUUID(),
      input.userId,
      input.hash,
      input.filename,
      input.contentType,
      input.size,
      input.width,
      input.height,
      input.sourceUrl,
      now,
      now,
    );

  const row = sqlite
    .prepare('SELECT * FROM gif_favorites WHERE user_id = ? AND hash = ?')
    .get(input.userId, input.hash) as GifFavoriteRow | undefined;
  if (!row) throw new Error('Failed to keep a gif');
  return row;
}

export function listGifFavoritesForUser(sqlite: DatabaseSync, userId: string): GifFavoriteRow[] {
  return sqlite
    .prepare('SELECT * FROM gif_favorites WHERE user_id = ? ORDER BY used_at DESC, rowid DESC')
    .all(userId) as unknown as GifFavoriteRow[];
}

export function findGifFavorite(sqlite: DatabaseSync, id: string): GifFavoriteRow | null {
  return (sqlite.prepare('SELECT * FROM gif_favorites WHERE id = ?').get(id) as GifFavoriteRow | undefined) ?? null;
}

export function deleteGifFavorite(sqlite: DatabaseSync, id: string): boolean {
  const result = sqlite.prepare('DELETE FROM gif_favorites WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/** Moves a kept gif forward, so sending it counts as using it. */
export function touchGifFavorite(sqlite: DatabaseSync, userId: string, hash: string): void {
  sqlite
    .prepare('UPDATE gif_favorites SET used_at = ? WHERE user_id = ? AND hash = ?')
    .run(new Date().toISOString(), userId, hash);
}

/** Favourites nobody has favourited or sent since `before`. */
export function deleteGifFavoritesUnusedBefore(sqlite: DatabaseSync, before: string): number {
  const result = sqlite.prepare('DELETE FROM gif_favorites WHERE used_at < ?').run(before);
  return Number(result.changes);
}

/**
 * A member's saved gifs by content hash, so a listing can mark the ones already
 * kept without a query per gif.
 */
export function favoriteIdsByHash(sqlite: DatabaseSync, userId: string): Map<string, string> {
  const rows = sqlite
    .prepare('SELECT id, hash FROM gif_favorites WHERE user_id = ?')
    .all(userId) as unknown as Array<{ id: string; hash: string }>;
  return new Map(rows.map((row) => [row.hash, row.id]));
}
