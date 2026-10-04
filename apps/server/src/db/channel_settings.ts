import type { DatabaseSync } from 'node:sqlite';
import { isMuteActive, type ChannelNotificationSettings, type NotificationLevel } from '@harmony/shared';

export interface ChannelSettingsRow {
  user_id: string;
  channel_id: string | null;
  category_id: string | null;
  muted: number;
  mute_ends_at: string | null;
  level: string;
  updated_at: string;
}

/** Which channel or category a row is about. */
export interface SettingsTarget {
  type: 'channel' | 'category';
  id: string;
}

/**
 * The API shape of a row. A mute whose end has passed is reported as no mute at
 * all, so a client never has to second-guess a stale flag against its own clock.
 */
export function toChannelSettings(row: ChannelSettingsRow, now: number = Date.now()): ChannelNotificationSettings {
  const stored = { muted: row.muted === 1, muteEndsAt: row.mute_ends_at };
  const muted = isMuteActive(stored, now);
  return {
    targetId: row.channel_id ?? row.category_id ?? '',
    targetType: row.channel_id !== null ? 'channel' : 'category',
    muted,
    muteEndsAt: muted ? row.mute_ends_at : null,
    level: row.level as NotificationLevel,
  };
}

/** Every row a member has, for channels and categories alike. */
export function listChannelSettings(sqlite: DatabaseSync, userId: string): ChannelSettingsRow[] {
  return sqlite
    .prepare('SELECT * FROM channel_settings WHERE user_id = ?')
    .all(userId) as unknown as ChannelSettingsRow[];
}

function column(target: SettingsTarget): 'channel_id' | 'category_id' {
  return target.type === 'channel' ? 'channel_id' : 'category_id';
}

export function findChannelSettings(
  sqlite: DatabaseSync,
  userId: string,
  target: SettingsTarget,
): ChannelSettingsRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM channel_settings WHERE user_id = ? AND ${column(target)} = ?`)
    .get(userId, target.id) as unknown as ChannelSettingsRow | undefined;
}

/**
 * Stores a member's settings for one target. Settings that come back to the
 * defaults (no mute in force, level left to the default) are deleted instead,
 * so the table only ever holds what somebody actually changed.
 */
export function saveChannelSettings(
  sqlite: DatabaseSync,
  userId: string,
  target: SettingsTarget,
  values: { muted: boolean; muteEndsAt: string | null; level: NotificationLevel; updatedAt: string },
): void {
  const key = column(target);
  if (!values.muted && values.level === 'default') {
    sqlite.prepare(`DELETE FROM channel_settings WHERE user_id = ? AND ${key} = ?`).run(userId, target.id);
    return;
  }

  const muted = values.muted ? 1 : 0;
  const muteEndsAt = values.muted ? values.muteEndsAt : null;
  // One upsert rather than an update then an insert: two first saves of the same
  // target racing each other would otherwise have one hit the partial unique
  // index. The conflict target names the same partial index that applies to this
  // column, so SQLite can match it.
  sqlite
    .prepare(
      `INSERT INTO channel_settings (user_id, ${key}, muted, mute_ends_at, level, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, ${key}) WHERE ${key} IS NOT NULL
       DO UPDATE SET muted = excluded.muted, mute_ends_at = excluded.mute_ends_at,
                     level = excluded.level, updated_at = excluded.updated_at`,
    )
    .run(userId, target.id, muted, muteEndsAt, values.level, values.updatedAt);
}
