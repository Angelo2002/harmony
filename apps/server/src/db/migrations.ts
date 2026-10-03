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
  {
    version: 4,
    name: 'discord_bridge',
    up(db) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN discord_channel_id TEXT;
        ALTER TABLE channels ADD COLUMN discord_webhook_id TEXT;
        ALTER TABLE channels ADD COLUMN discord_webhook_token TEXT;
        ALTER TABLE users ADD COLUMN discord_id TEXT;

        CREATE UNIQUE INDEX idx_channels_discord
          ON channels(discord_channel_id) WHERE discord_channel_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_users_discord
          ON users(discord_id) WHERE discord_id IS NOT NULL;

        CREATE TABLE bridge_messages (
          harmony_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          discord_message_id TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX idx_bridge_messages_discord ON bridge_messages(discord_message_id);
      `);
    },
  },
  {
    version: 5,
    name: 'message_replies',
    up(db) {
      // A reply points at its parent; if the parent is ever hard-deleted
      // (retention), the reply simply becomes a normal message.
      db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL`);
    },
  },
  {
    version: 6,
    name: 'message_reactions',
    up(db) {
      db.exec(`
        CREATE TABLE reactions (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          /* A unicode character, or ':name:' for a custom emoji. */
          emoji      TEXT NOT NULL,
          /* The custom emoji id, for custom emoji only. */
          emoji_id   TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (message_id, user_id, emoji)
        );
        CREATE INDEX idx_reactions_message ON reactions(message_id);
      `);
    },
  },
  {
    version: 7,
    name: 'moderation',
    up(db) {
      db.exec(`
        /* An active timeout, or NULL when the user is not timed out. */
        ALTER TABLE users ADD COLUMN timed_out_until TEXT;

        CREATE TABLE bans (
          user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
          reason     TEXT,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: 'user_typing_preference',
    up(db) {
      /* 1 means typing indicators are on, which is the default for everyone. */
      db.exec(`ALTER TABLE users ADD COLUMN show_typing INTEGER NOT NULL DEFAULT 1`);
    },
  },
  {
    version: 9,
    name: 'message_embeds',
    up(db) {
      /* The unfurled link preview as JSON, or NULL when there is none. */
      db.exec(`ALTER TABLE messages ADD COLUMN embed TEXT`);
    },
  },
  {
    version: 10,
    name: 'channel_roles',
    up(db) {
      db.exec(`
        /* A role required to see a channel; NULL means open to everyone. */
        ALTER TABLE channels ADD COLUMN required_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
        /* A required role on a category covers every channel inside it. */
        ALTER TABLE categories ADD COLUMN required_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
      `);
    },
  },
  {
    version: 11,
    name: 'audit_log',
    up(db) {
      db.exec(`
        CREATE TABLE audit_log (
          id         TEXT PRIMARY KEY,
          kind       TEXT NOT NULL,
          /* Who acted, and who it happened to. Set NULL when that account goes. */
          actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
          /* Kind-specific fields as JSON, e.g. the text before an edit. */
          detail     TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
      `);
    },
  },
  {
    version: 12,
    name: 'channel_slowmode',
    up(db) {
      /* Seconds a member must wait between messages; 0 means slowmode is off. */
      db.exec(`ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 13,
    name: 'user_notification_sounds',
    up(db) {
      /*
       * The two in-app notification sounds. Both default to on, and neither is
       * about device notifications: nothing is ever pushed off the page.
       */
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_major INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE users ADD COLUMN notify_minor INTEGER NOT NULL DEFAULT 1;
      `);
    },
  },
  {
    version: 14,
    name: 'attachment_source_url',
    up(db) {
      /*
       * The link an attachment was copied from, when it was fetched rather than
       * uploaded. NULL for anything someone actually attached themselves, which
       * is how the two are told apart: a linked image is kept in step with the
       * message's text, while an upload belongs to the message and stays.
       */
      db.exec(`ALTER TABLE attachments ADD COLUMN source_url TEXT`);
    },
  },
  {
    version: 15,
    name: 'gif_favorites',
    up(db) {
      /*
       * A gif somebody kept, held by content hash rather than by any message.
       * That is the whole point: a favorite has to outlive the message it was
       * found in, so it cannot be a reference to an attachment row, which is
       * deleted along with its message. `used_at` is what the retention rule for
       * favorites counts from, and it moves when the gif is favorited or sent.
       */
      db.exec(`
        CREATE TABLE gif_favorites (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          hash         TEXT NOT NULL,
          filename     TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size         INTEGER NOT NULL,
          width        INTEGER,
          height       INTEGER,
          source_url   TEXT,
          created_at   TEXT NOT NULL,
          used_at      TEXT NOT NULL,
          UNIQUE(user_id, hash)
        );
        CREATE INDEX idx_gif_favorites_user ON gif_favorites(user_id, used_at DESC);
        CREATE INDEX idx_gif_favorites_hash ON gif_favorites(hash);
      `);
    },
  },
  {
    version: 16,
    name: 'channel_reads',
    up(db) {
      /*
       * How far each member has read each channel, which is what makes a channel
       * with something new in it stand out in the sidebar. It is deliberately a
       * timestamp rather than a message id: ids here are random rather than
       * ordered, and history imported from Discord arrives with its original
       * timestamps, so an old import reads as already seen instead of lighting a
       * channel up with months of backfill. Only the member it belongs to ever
       * sees it; it is not a read receipt and nobody else can tell.
       */
      db.exec(`
        CREATE TABLE channel_reads (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          read_at    TEXT NOT NULL,
          PRIMARY KEY (user_id, channel_id)
        );
      `);
    },
  },
  {
    version: 17,
    name: 'mentions',
    up(db) {
      /*
       * Every message that named or replied to a member, recorded as the message
       * is written so the inbox can be listed and its badge drawn without ever
       * scanning message text. Rows follow their message: a hard delete
       * (retention) takes them along, while a soft delete leaves them for the
       * message's own deleted filter to hide.
       *
       * Like the read marker, this is one member's own list and nobody else's
       * business: it is not a public record of who was summoned by whom.
       */
      db.exec(`
        CREATE TABLE mentions (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          /* Denormalized so a per-channel lookup needs no join onto the message. */
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          /* 'mention' when named, 'reply' when the message answered theirs. */
          kind       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (message_id, user_id)
        );
        CREATE INDEX idx_mentions_user_created ON mentions(user_id, created_at DESC);
        CREATE INDEX idx_mentions_user_channel ON mentions(user_id, channel_id);
      `);
    },
  },
  {
    version: 18,
    name: 'bridge_seen',
    up(db) {
      /*
       * Every Discord message id the bridge has ever accounted for, whether it
       * was imported from Discord or sent there by us on a member's behalf. It
       * exists because bridge_messages cannot answer "have I seen this before?"
       * on its own: that mapping is deleted when a message is deleted, and is
       * cascaded away when retention hard-deletes one, so a backfill would keep
       * re-importing content that had deliberately been removed. This record is
       * never deleted with a message, so a re-fetched Discord id is recognised
       * and skipped however the Harmony message it once mapped to went away.
       *
       * Rows are a snowflake id and a timestamp - a few dozen bytes - so keeping
       * them for the life of the instance is cheap, and it is what makes pruning
       * and deletion stick. Existing mappings are seeded so an upgrade keeps the
       * dedup it already had.
       */
      db.exec(`
        CREATE TABLE bridge_seen (
          discord_message_id TEXT PRIMARY KEY,
          first_seen_at      TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO bridge_seen (discord_message_id, first_seen_at)
        SELECT discord_message_id, created_at FROM bridge_messages
      `);
    },
  },
];
