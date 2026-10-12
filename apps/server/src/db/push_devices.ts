import type { DatabaseSync } from 'node:sqlite';

/** One registered push endpoint, as stored. */
export interface PushDeviceRow {
  user_id: string;
  endpoint: string;
  platform: string;
  created_at: string;
  updated_at: string;
}

/**
 * Registers, or refreshes, one push endpoint for a member.
 *
 * The endpoint is per install, so registering it again after a rotation or a
 * retry is an update rather than a duplicate, which is what makes the `PUT`
 * idempotent under the shell's at-least-once registration. The pair is the key
 * so two accounts signed in on one install keep separate registrations.
 */
export function upsertPushDevice(
  sqlite: DatabaseSync,
  userId: string,
  endpoint: string,
  platform: string,
  now: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO push_devices (user_id, endpoint, platform, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE
         SET platform = excluded.platform, updated_at = excluded.updated_at`,
    )
    .run(userId, endpoint, platform, now, now);
}

/** Removes a member's registration for one endpoint; removing an absent one is a no-op. */
export function deletePushDevice(sqlite: DatabaseSync, userId: string, endpoint: string): void {
  sqlite.prepare('DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

/** Every endpoint a member has registered, newest first, for delivery to each in turn. */
export function listPushDevices(sqlite: DatabaseSync, userId: string): PushDeviceRow[] {
  return sqlite
    .prepare(
      `SELECT user_id, endpoint, platform, created_at, updated_at
         FROM push_devices WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as unknown as PushDeviceRow[];
}
