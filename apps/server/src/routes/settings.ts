import type { FastifyInstance } from 'fastify';
import { Permission, updateSettingsSchema, type ServerSettingsResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { findChannel } from '../db/channels.ts';
import type { Database } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { SettingsService } from '../settings/service.ts';

export interface SettingsRouteDeps {
  settings: SettingsService;
  db: Database;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const { settings, db } = deps;

  app.get('/api/v1/settings', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const body: ServerSettingsResponse = settings.get();
    return body;
  });

  app.patch('/api/v1/settings', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(updateSettingsSchema, request.body);
    // A default channel must be a real channel; null is allowed and means "none".
    if (input.defaultChannelId != null && !findChannel(db.sqlite, input.defaultChannelId)) {
      throw new HttpError(400, 'invalid_default_channel', 'That channel does not exist.');
    }
    const body: ServerSettingsResponse = settings.update(input);
    return body;
  });
}
