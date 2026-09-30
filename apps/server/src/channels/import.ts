import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  LIMITS,
  type ChannelImportResponse,
  type DiscordChannelImportGroup,
  type DiscordChannelImportOption,
  type DiscordChannelImportPreview,
} from '@harmony/shared';
import type { BridgeService } from '../bridge/service.ts';
import {
  findCategory,
  insertCategory,
  listCategories,
  nextCategoryPosition,
  toCategory,
} from '../db/categories.ts';
import { findChannel, insertChannel, listChannels, nextChannelPosition, toChannel } from '../db/channels.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface ChannelImportDeps {
  sqlite: DatabaseSync;
  bridge: BridgeService;
  hub: GatewayHub;
  log(message: string, detail?: unknown): void;
}

export interface ChannelImportService {
  /** The linked guild's channels, grouped as the import preview shows them. */
  discordChannels(): Promise<DiscordChannelImportPreview>;
  /**
   * Creates and bridges a Harmony channel for every Discord channel not yet
   * linked, or for just the ones named in `selection`.
   */
  importMissing(selection?: { channelIds?: string[] }): Promise<ChannelImportResponse>;
}

/**
 * Recreates a Discord server's channel list in Harmony, bridging each channel as
 * it goes, so a migration does not mean rebuilding the sidebar by hand. Discord
 * ids are the join key: a channel already bridged anywhere is skipped, which
 * makes the import safe to run again. A Discord category becomes a Harmony
 * category of the same name, reused rather than duplicated when it already
 * exists.
 */
export function createChannelImportService(deps: ChannelImportDeps): ChannelImportService {
  const maxName = LIMITS.channelName.max;

  /** Discord channel ids that already have a Harmony counterpart. */
  function bridgedDiscordIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of listChannels(deps.sqlite)) {
      if (row.discord_channel_id) ids.add(row.discord_channel_id);
    }
    return ids;
  }

  function announceCategory(id: string): void {
    const row = findCategory(deps.sqlite, id);
    if (row) deps.hub.dispatch(GatewayEvent.CategoryCreate, toCategory(row), { categoryId: id });
  }

  function announceChannel(id: string): void {
    const row = findChannel(deps.sqlite, id);
    if (!row) return;
    const channel = toChannel(row);
    deps.hub.dispatch(GatewayEvent.ChannelCreate, channel, { channelId: channel.id });
  }

  /** Pulls each new channel's recent history, one at a time to avoid a burst. */
  async function backfill(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await deps.bridge.importChannel(id);
      } catch (error) {
        deps.log('could not backfill an imported channel', {
          channelId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    async discordChannels() {
      const { guildName, categories, channels } = await deps.bridge.listDiscordChannels();
      const bridged = bridgedDiscordIds();

      // Channels whose category the bot cannot see fall back to the top level.
      const buckets = new Map<string, DiscordChannelImportOption[]>();
      for (const category of categories) buckets.set(category.id, []);
      const topLevel: DiscordChannelImportOption[] = [];

      for (const channel of channels) {
        const option: DiscordChannelImportOption = {
          id: channel.id,
          name: channel.name,
          bridged: bridged.has(channel.id),
        };
        const bucket = channel.categoryId !== null ? buckets.get(channel.categoryId) : undefined;
        (bucket ?? topLevel).push(option);
      }

      const groups: DiscordChannelImportGroup[] = [];
      if (topLevel.length > 0) groups.push({ categoryName: null, channels: topLevel });
      for (const category of categories) {
        const list = buckets.get(category.id) ?? [];
        if (list.length > 0) groups.push({ categoryName: category.name, channels: list });
      }

      return { guildName, groups };
    },

    async importMissing(selection) {
      const { guildName, categories, channels } = await deps.bridge.listDiscordChannels();
      if (guildName === null) {
        throw new HttpError(503, 'bridge_offline', 'The Discord bridge is not connected, so there is nothing to import.');
      }

      // A selection narrows the run to those channels; anything else is left for
      // a later import rather than counted as skipped.
      const requested = selection?.channelIds ? new Set(selection.channelIds) : null;
      const bridged = bridgedDiscordIds();
      const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
      // Reuse a Harmony category of the same name, so a second run, or a server
      // that already has one, does not end up with duplicates.
      const categoryIdByName = new Map(listCategories(deps.sqlite).map((row) => [row.name, row.id]));

      const createdIds: string[] = [];
      let skipped = 0;
      let failed = 0;
      let categoriesCreated = 0;

      for (const channel of channels) {
        if (requested !== null && !requested.has(channel.id)) continue;
        if (bridged.has(channel.id)) {
          skipped++;
          continue;
        }
        if (channel.name.length < 1 || channel.name.length > maxName) {
          failed++;
          deps.log('skipped a discord channel whose name does not fit', { name: channel.name });
          continue;
        }

        let categoryId: string | null = null;
        const wanted = channel.categoryId !== null ? (categoryNameById.get(channel.categoryId) ?? null) : null;
        if (wanted !== null && wanted.length <= maxName) {
          const existing = categoryIdByName.get(wanted);
          if (existing !== undefined) {
            categoryId = existing;
          } else {
            categoryId = randomUUID();
            insertCategory(deps.sqlite, {
              id: categoryId,
              name: wanted,
              position: nextCategoryPosition(deps.sqlite),
            });
            categoryIdByName.set(wanted, categoryId);
            categoriesCreated++;
            announceCategory(categoryId);
          }
        }

        const id = randomUUID();
        insertChannel(deps.sqlite, {
          id,
          name: channel.name,
          topic: null,
          categoryId,
          type: 'text',
          position: nextChannelPosition(deps.sqlite, categoryId),
          createdAt: new Date().toISOString(),
          discordChannelId: channel.id,
          requiredRoleId: null,
        });
        createdIds.push(id);
      }

      for (const id of createdIds) announceChannel(id);
      // Backfill in the background so a large import does not hold up the reply.
      void backfill(createdIds);

      return { imported: createdIds.length, skipped, failed, categoriesCreated };
    },
  };
}
