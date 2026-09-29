import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { migrations } from './migrations.ts';
import type { Config } from '../config.ts';

/**
 * Thin wrapper around Node's built-in SQLite. No native modules and no ORM:
 * the entire server lives in a single file, which is exactly what a small
 * self-hosted community wants for backup and portability.
 */
export class Database {
  readonly sqlite: DatabaseSync;

  constructor(config: Config) {
    mkdirSync(config.dataDir, { recursive: true });
    this.sqlite = new DatabaseSync(config.dbFile);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.sqlite.exec('PRAGMA busy_timeout = 5000;');
    this.#migrate();
  }

  #migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const rows = this.sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>;
    const applied = new Set(rows.map((row) => row.version));

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.sqlite.exec('BEGIN');
      try {
        migration.up(this.sqlite);
        this.sqlite
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.sqlite.exec('COMMIT');
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.sqlite.close();
  }
}
