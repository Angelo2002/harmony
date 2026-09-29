import type { FastifyInstance } from 'fastify';
import { Permission, updateSettingsSchema, type ServerSettingsResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseBody } from '../http/validation.ts';
import type { SettingsService } from '../settings/service.ts';

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService): void {
  app.get('/api/v1/settings', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const body: ServerSettingsResponse = settings.get();
    return body;
  });

  app.patch('/api/v1/settings', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(updateSettingsSchema, request.body);
    const body: ServerSettingsResponse = settings.update(input);
    return body;
  });
}
