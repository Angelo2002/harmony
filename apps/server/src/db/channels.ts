import type { DatabaseSync } from 'node:sqlite';
import type { Channel, ChannelType } from '@harmony/shared';

export interface ChannelRow {
  id: string;
  name: string;
  topic: string | null;
  type: string;
  category_id: string | null;
  position: number;
  created_at: string;
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    type: row.type as ChannelType,
    categoryId: row.category_id,
    position: row.position,
    createdAt: row.created_at,
  };
}

export function listChannels(sqlite: DatabaseSync): ChannelRow[] {
  return sqlite.prepare('SELECT * FROM channels ORDER BY position, name').all() as unknown as ChannelRow[];
}

export function findChannel(sqlite: DatabaseSync, id: string): ChannelRow | null {
  return (sqlite.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined) ?? null;
}

export function nextChannelPosition(sqlite: DatabaseSync, categoryId: string | null): number {
  const row = sqlite
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM channels WHERE category_id IS ?')
    .get(categoryId) as { position: number };
  return row.position;
}

export function insertChannel(
  sqlite: DatabaseSync,
  input: {
    id: string;
    name: string;
    topic: string | null;
    categoryId: string | null;
    type: string;
    position: number;
    createdAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO channels (id, name, topic, type, category_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.name, input.topic, input.type, input.categoryId, input.position, input.createdAt);
}

export function updateChannel(
  sqlite: DatabaseSync,
  id: string,
  patch: { name?: string; topic?: string | null; categoryId?: string | null; position?: number },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.topic !== undefined) {
    sets.push('topic = ?');
    values.push(patch.topic);
  }
  if (patch.categoryId !== undefined) {
    sets.push('category_id = ?');
    values.push(patch.categoryId);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteChannel(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM channels WHERE id = ?').run(id);
}
