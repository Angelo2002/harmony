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
  discord_channel_id: string | null;
  discord_webhook_id: string | null;
  discord_webhook_token: string | null;
  required_role_id: string | null;
  slowmode_seconds: number;
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
    discordChannelId: row.discord_channel_id,
    requiredRoleId: row.required_role_id,
    slowmodeSeconds: row.slowmode_seconds,
  };
}

export function listChannels(sqlite: DatabaseSync): ChannelRow[] {
  return sqlite.prepare('SELECT * FROM channels ORDER BY position, name').all() as unknown as ChannelRow[];
}

/** One category's channels in display order. `null` means "no category". */
export function listChannelsInCategory(sqlite: DatabaseSync, categoryId: string | null): ChannelRow[] {
  return sqlite
    .prepare('SELECT * FROM channels WHERE category_id IS ? ORDER BY position, name')
    .all(categoryId) as unknown as ChannelRow[];
}

export function findChannel(sqlite: DatabaseSync, id: string): ChannelRow | null {
  return (sqlite.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined) ?? null;
}

export function findChannelByDiscordId(sqlite: DatabaseSync, discordChannelId: string): ChannelRow | null {
  return (
    (sqlite.prepare('SELECT * FROM channels WHERE discord_channel_id = ?').get(discordChannelId) as
      | ChannelRow
      | undefined) ?? null
  );
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
    discordChannelId: string | null;
    /** Optional so a caller that does not care about locking can omit it. */
    requiredRoleId?: string | null;
    /** Seconds between messages; omitted means off. */
    slowmodeSeconds?: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO channels (id, name, topic, type, category_id, position, created_at, discord_channel_id, required_role_id, slowmode_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.topic,
      input.type,
      input.categoryId,
      input.position,
      input.createdAt,
      input.discordChannelId,
      input.requiredRoleId ?? null,
      input.slowmodeSeconds ?? 0,
    );
}

export function updateChannel(
  sqlite: DatabaseSync,
  id: string,
  patch: {
    name?: string;
    topic?: string | null;
    categoryId?: string | null;
    position?: number;
    discordChannelId?: string | null;
    requiredRoleId?: string | null;
    slowmodeSeconds?: number;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.slowmodeSeconds !== undefined) {
    sets.push('slowmode_seconds = ?');
    values.push(patch.slowmodeSeconds);
  }
  if (patch.requiredRoleId !== undefined) {
    sets.push('required_role_id = ?');
    values.push(patch.requiredRoleId);
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
  if (patch.discordChannelId !== undefined) {
    sets.push('discord_channel_id = ?');
    values.push(patch.discordChannelId);
    // A webhook belongs to the Discord channel, so drop any cached one.
    sets.push('discord_webhook_id = NULL', 'discord_webhook_token = NULL');
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function setChannelWebhook(
  sqlite: DatabaseSync,
  channelId: string,
  webhookId: string,
  webhookToken: string,
): void {
  sqlite
    .prepare('UPDATE channels SET discord_webhook_id = ?, discord_webhook_token = ? WHERE id = ?')
    .run(webhookId, webhookToken, channelId);
}

export function deleteChannel(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM channels WHERE id = ?').run(id);
}

/** How many channels still live in a category, used to refuse deleting a busy one. */
export function countChannelsInCategory(sqlite: DatabaseSync, categoryId: string): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM channels WHERE category_id = ?').get(categoryId) as {
    count: number;
  };
  return row.count;
}

/**
 * Swaps a channel's position with its neighbour in the same category. Channels
 * only reorder inside their own category, so moving across categories is done
 * with `PATCH /channels/:id` instead.
 */
export function moveChannel(sqlite: DatabaseSync, id: string, direction: 'up' | 'down'): void {
  const row = findChannel(sqlite, id);
  if (!row) return;

  const ordered = listChannelsInCategory(sqlite, row.category_id);
  const index = ordered.findIndex((channel) => channel.id === id);
  const current = ordered[index];
  const neighbor = ordered[direction === 'up' ? index - 1 : index + 1];
  if (!current || !neighbor) return;

  sqlite.exec('BEGIN');
  try {
    sqlite.prepare('UPDATE channels SET position = ? WHERE id = ?').run(neighbor.position, current.id);
    sqlite.prepare('UPDATE channels SET position = ? WHERE id = ?').run(current.position, neighbor.id);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}
