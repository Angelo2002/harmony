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

export interface ChannelRouteDeps {
  db: Database;
  hub: GatewayHub;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { db, hub } = deps;

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

  app.get('/api/v1/channels', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const body: ChannelListResponse = {
      categories: listCategories(db.sqlite).map(toCategory),
      channels: listChannels(db.sqlite).map(toChannel),
    };
    return body;
  });

  app.post('/api/v1/channels', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(createChannelSchema, request.body);
    const categoryId = input.categoryId ?? null;
    if (categoryId) requireCategoryRow(categoryId);

    const id = randomUUID();
    insertChannel(db.sqlite, {
      id,
      name: input.name,
      topic: input.topic ?? null,
      categoryId,
      type: 'text',
      position: nextChannelPosition(db.sqlite, categoryId),
      createdAt: new Date().toISOString(),
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelCreate, channel);
    return channel;
  });

  app.patch('/api/v1/channels/:id', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    const input = parseBody(updateChannelSchema, request.body);
    if (input.categoryId) requireCategoryRow(input.categoryId);

    updateChannel(db.sqlite, id, {
      name: input.name,
      topic: input.topic,
      categoryId: input.categoryId,
      position: input.position,
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelUpdate, channel);
    return channel;
  });

  app.delete('/api/v1/channels/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    deleteChannel(db.sqlite, id);
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
