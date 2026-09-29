import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EVERYONE_PERMISSIONS, permissionsToString } from '@harmony/shared';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Ordered, append-only list of schema migrations. Each entry runs once and is
 * recorded in `schema_migrations`. Never edit a shipped migration; add a new
 * one instead so existing installations migrate cleanly.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name  TEXT,
          password_hash TEXT NOT NULL,
          avatar_hash   TEXT,
          is_bot        INTEGER NOT NULL DEFAULT 0,
          is_owner      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash   TEXT NOT NULL UNIQUE,
          user_agent   TEXT,
          created_at   TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          expires_at   TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);

        CREATE TABLE roles (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          color       INTEGER,
          position    INTEGER NOT NULL DEFAULT 0,
          permissions TEXT NOT NULL DEFAULT '0',
          hoist       INTEGER NOT NULL DEFAULT 0,
          mentionable INTEGER NOT NULL DEFAULT 0,
          is_default  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE member_roles (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, role_id)
        );

        CREATE TABLE categories (
          id       TEXT PRIMARY KEY,
          name     TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE channels (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          topic       TEXT,
          type        TEXT NOT NULL DEFAULT 'text',
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          position    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE messages (
          id         TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          content    TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          edited_at  TEXT,
          deleted_at TEXT
        );
        CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at);

        CREATE TABLE attachments (
          id           TEXT PRIMARY KEY,
          message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
          uploader_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          filename     TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size         INTEGER NOT NULL,
          width        INTEGER,
          height       INTEGER,
          hash         TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_attachments_message ON attachments(message_id);
        CREATE INDEX idx_attachments_hash ON attachments(hash);

        CREATE TABLE emojis (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          hash       TEXT NOT NULL,
          animated   INTEGER NOT NULL DEFAULT 0,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE invites (
          code       TEXT PRIMARY KEY,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          max_uses   INTEGER,
          uses       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE server_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Every instance starts with the implicit @everyone role.
      db.prepare(
        `INSERT INTO roles (id, name, position, permissions, is_default, created_at)
         VALUES ('everyone', '@everyone', 0, ?, 1, ?)`,
      ).run(permissionsToString(EVERYONE_PERMISSIONS), new Date().toISOString());
    },
  },
  {
    version: 2,
    name: 'default_category_and_channel',
    up(db) {
      // Seed Discord's familiar starting point, but only on a fresh instance.
      const existing = db.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number };
      if (existing.count > 0) return;

      const categoryId = randomUUID();
      db.prepare('INSERT INTO categories (id, name, position) VALUES (?, ?, 0)').run(
        categoryId,
        'Text Channels',
      );
      db.prepare(
        `INSERT INTO channels (id, name, type, category_id, position, created_at)
         VALUES (?, 'general', 'text', ?, 0, ?)`,
      ).run(randomUUID(), categoryId, new Date().toISOString());
    },
  },
  {
    version: 3,
    name: 'emoji_content_type',
    up(db) {
      // Needed to serve emoji images with the right Content-Type.
      db.exec(`ALTER TABLE emojis ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/png'`);
    },
  },
];
