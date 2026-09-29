import { emojiNameSchema, type DiscordEmojiListResponse, type Emoji } from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { BridgeService } from '../bridge/service.ts';
import { HttpError } from '../http/errors.ts';
import type { EmojiService } from './service.ts';

export interface EmojiImportDeps {
  emojis: EmojiService;
  bridge: BridgeService;
  log(message: string, detail?: unknown): void;
}

export interface EmojiImportOutcome {
  /** The emoji that were stored, so the caller can announce them. */
  imported: Emoji[];
  skipped: number;
  failed: number;
}

export interface EmojiImportService {
  /** The linked guild's emoji, each marked with whether Harmony already has it. */
  discordEmojis(): Promise<DiscordEmojiListResponse>;
  /** Downloads and stores every guild emoji Harmony does not already have. */
  importMissing(auth: AuthContext): Promise<EmojiImportOutcome>;
}

/**
 * Copies the linked Discord server's custom emoji into Harmony so an instance
 * migrating off Discord does not have to rebuild them by hand. Names are the
 * join key: an emoji whose name already exists is left alone, which also makes
 * running the import twice harmless.
 */
export function createEmojiImportService(deps: EmojiImportDeps): EmojiImportService {
  function existingNames(): Set<string> {
    return new Set(deps.emojis.list().map((emoji) => emoji.name));
  }

  return {
    async discordEmojis() {
      const { guildName, emojis } = await deps.bridge.listGuildEmojis();
      const existing = existingNames();
      return {
        guildName,
        emojis: emojis.map((emoji) => ({ ...emoji, imported: existing.has(emoji.name) })),
      };
    },

    async importMissing(auth) {
      const { guildName, emojis } = await deps.bridge.listGuildEmojis();
      if (guildName === null) {
        throw new HttpError(503, 'bridge_offline', 'The Discord bridge is not connected, so there is nothing to import.');
      }

      const existing = existingNames();
      const imported: Emoji[] = [];
      let skipped = 0;
      let failed = 0;

      for (const emoji of emojis) {
        if (existing.has(emoji.name)) {
          skipped++;
          continue;
        }

        // Discord names and Harmony names mostly agree, but one odd name must
        // not abort the whole import.
        if (!emojiNameSchema.safeParse(emoji.name).success) {
          failed++;
          deps.log('skipped a discord emoji with an unusable name', { name: emoji.name });
          continue;
        }

        try {
          const file = await deps.bridge.downloadGuildEmoji(emoji.id, emoji.animated);
          const created = await deps.emojis.create(auth, emoji.name, {
            filename: emoji.name,
            contentType: file.contentType,
            data: file.data,
          });
          // Guard against two Discord emoji sharing a name.
          existing.add(emoji.name);
          imported.push(created);
        } catch (error) {
          failed++;
          deps.log('could not import a discord emoji', {
            name: emoji.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { imported, skipped, failed };
    },
  };
}
