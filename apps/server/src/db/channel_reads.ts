import type { DatabaseSync } from 'node:sqlite';

/**
 * How far a member has read a channel. Kept as the time of the newest message
 * they have seen, so a channel is unread when it holds anything newer.
 */
export function markChannelRead(sqlite: DatabaseSync, userId: string, channelId: string, readAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE
         SET read_at = MAX(channel_reads.read_at, excluded.read_at)`,
    )
    .run(userId, channelId, readAt);
}

/**
 * Which of these channels hold something this member has not read.
 *
 * A channel nobody has ever opened counts as unread as soon as it has a message,
 * which is what makes a fresh account on an established instance show what it has
 * missed. Callers pass only the channels the member may see, so a locked channel
 * is not even considered.
 */
export function listUnreadChannelIds(sqlite: DatabaseSync, userId: string, channelIds: string[]): string[] {
  if (channelIds.length === 0) return [];

  const placeholders = channelIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT m.channel_id AS id
         FROM messages m
         LEFT JOIN channel_reads r ON r.user_id = ? AND r.channel_id = m.channel_id
        WHERE m.channel_id IN (${placeholders})
        GROUP BY m.channel_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.read_at), '')`,
    )
    .all(userId, ...channelIds) as unknown as Array<{ id: string }>;

  return rows.map((row) => row.id);
}
