import type { DatabaseSync } from 'node:sqlite';

export interface BridgeMessageRow {
  harmony_message_id: string;
  discord_message_id: string;
  created_at: string;
}

/** Records which Discord message a Harmony message was mirrored to (and back). */
export function insertBridgeMessage(
  sqlite: DatabaseSync,
  input: { harmonyMessageId: string; discordMessageId: string; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO bridge_messages (harmony_message_id, discord_message_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(input.harmonyMessageId, input.discordMessageId, input.createdAt);
}

export function findBridgeMessageByDiscordId(
  sqlite: DatabaseSync,
  discordMessageId: string,
): BridgeMessageRow | null {
  return (
    (sqlite.prepare('SELECT * FROM bridge_messages WHERE discord_message_id = ?').get(discordMessageId) as
      | BridgeMessageRow
      | undefined) ?? null
  );
}

export function findBridgeMessageByHarmonyId(
  sqlite: DatabaseSync,
  harmonyMessageId: string,
): BridgeMessageRow | null {
  return (
    (sqlite.prepare('SELECT * FROM bridge_messages WHERE harmony_message_id = ?').get(harmonyMessageId) as
      | BridgeMessageRow
      | undefined) ?? null
  );
}

export function deleteBridgeMessage(sqlite: DatabaseSync, harmonyMessageId: string): void {
  sqlite.prepare('DELETE FROM bridge_messages WHERE harmony_message_id = ?').run(harmonyMessageId);
}
