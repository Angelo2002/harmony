import type { DatabaseSync } from 'node:sqlite';

/** Reads every stored setting as a raw key/value map. */
export function readAllSettings(sqlite: DatabaseSync): Map<string, string> {
  const rows = sqlite.prepare('SELECT key, value FROM server_settings').all() as unknown as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function writeSetting(sqlite: DatabaseSync, key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}
