import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  createCategorySchema,
  createChannelSchema,
  updateCategorySchema,
  updateChannelSchema,
  type ChannelListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { BridgeService } from '../bridge/service.ts';
import {
  deleteCategory,
  findCategory,
  insertCategory,
  listCategories,
  nextCategoryPosition,
  toCategory,
  updateCategory,
  type CategoryRow,
} from '../db/categories.ts';
import {
  deleteChannel,
  findChannel,
  findChannelByDiscordId,
  insertChannel,
  listChannels,
  nextChannelPosition,
  toChannel,
  updateChannel,
  type ChannelRow,
} from '../db/channels.ts';
import type { Database } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';

export interface ChannelRouteDeps {
  db: Database;
  hub: GatewayHub;
  bridge: BridgeService;
  settings: SettingsService;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { db, hub, settings } = deps;

  /**
   * Best effort: pull the Discord channel's recent history once it is linked, so
   * a new bridge does not start out empty. It is idempotent, and a disabled
   * bridge simply fails here and is ignored.
   */
  function backfill(channelId: string): void {
    void deps.bridge.importChannel(channelId).catch(() => undefined);
  }

  function requireChannelRow(id: string): ChannelRow {
    const row = findChannel(db.sqlite, id);
    if (!row) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    return row;
  }

  function requireCategoryRow(id: string): CategoryRow {
    const row = findCategory(db.sqlite, id);
    if (!row) throw new HttpError(404, 'category_not_found', 'That category does not exist.');
    return row;
  }

  /** A Discord channel can only feed one Harmony channel. */
  function assertDiscordChannelFree(discordChannelId: string, exceptChannelId: string | null): void {
    const existing = findChannelByDiscordId(db.sqlite, discordChannelId);
    if (existing && existing.id !== exceptChannelId) {
      throw new HttpError(409, 'discord_channel_taken', 'That Discord channel is already bridged elsewhere.');
    }
  }

  app.get('/api/v1/channels', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const body: ChannelListResponse = {
      categories: listCategories(db.sqlite).map(toCategory),
      channels: listChannels(db.sqlite).map(toChannel),
      // Freshly read every time, so a client picks up an admin's change on reload.
      defaultChannelId: settings.get().defaultChannelId,
    };
    return body;
  });

  app.post('/api/v1/channels', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(createChannelSchema, request.body);
    const categoryId = input.categoryId ?? null;
    if (categoryId) requireCategoryRow(categoryId);

    const discordChannelId = input.discordChannelId ?? null;
    if (discordChannelId) assertDiscordChannelFree(discordChannelId, null);

    const id = randomUUID();
    insertChannel(db.sqlite, {
      id,
      name: input.name,
      topic: input.topic ?? null,
      categoryId,
      type: 'text',
      position: nextChannelPosition(db.sqlite, categoryId),
      createdAt: new Date().toISOString(),
      discordChannelId,
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelCreate, channel);
    if (channel.discordChannelId) backfill(channel.id);
    return channel;
  });

  app.patch('/api/v1/channels/:id', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    const input = parseBody(updateChannelSchema, request.body);
    if (input.categoryId) requireCategoryRow(input.categoryId);
    if (input.discordChannelId) assertDiscordChannelFree(input.discordChannelId, id);

    updateChannel(db.sqlite, id, {
      name: input.name,
      topic: input.topic,
      categoryId: input.categoryId,
      position: input.position,
      discordChannelId: input.discordChannelId,
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelUpdate, channel);
    if (input.discordChannelId) backfill(channel.id);
    return channel;
  });

  app.delete('/api/v1/channels/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    deleteChannel(db.sqlite, id);
    // Do not leave the default pointing at a channel that no longer exists.
    if (settings.get().defaultChannelId === id) settings.update({ defaultChannelId: null });
    hub.dispatch(GatewayEvent.ChannelDelete, { id });
    return reply.status(204).send();
  });

  app.post('/api/v1/categories', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(createCategorySchema, request.body);

    const id = randomUUID();
    insertCategory(db.sqlite, { id, name: input.name, position: nextCategoryPosition(db.sqlite) });

    const category = toCategory(requireCategoryRow(id));
    hub.dispatch(GatewayEvent.CategoryCreate, category);
    return category;
  });

  app.patch('/api/v1/categories/:id', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireCategoryRow(id);

    const input = parseBody(updateCategorySchema, request.body);
    updateCategory(db.sqlite, id, { name: input.name, position: input.position });

    const category = toCategory(requireCategoryRow(id));
    hub.dispatch(GatewayEvent.CategoryUpdate, category);
    return category;
  });

  app.delete('/api/v1/categories/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireCategoryRow(id);

    deleteCategory(db.sqlite, id);
    hub.dispatch(GatewayEvent.CategoryDelete, { id });
    return reply.status(204).send();
  });
}
