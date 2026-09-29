import type { FastifyInstance } from 'fastify';
import { Permission, updateBridgeSchema, type BridgeResponse, type DiscordChannelListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { BridgeService } from '../bridge/service.ts';
import { parseBody } from '../http/validation.ts';
import type { SettingsService } from '../settings/service.ts';

export interface BridgeRouteDeps {
  settings: SettingsService;
  bridge: BridgeService;
}

export function registerBridgeRoutes(app: FastifyInstance, deps: BridgeRouteDeps): void {
  app.get('/api/v1/bridge', async (request) => {
    requirePermission(request, Permission.ManageServer);
    return deps.bridge.status();
  });

  app.patch('/api/v1/bridge', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(updateBridgeSchema, request.body);
    deps.settings.updateBridge(input);
    await deps.bridge.applySettings();

    const body: BridgeResponse = deps.bridge.status();
    return body;
  });

  app.get('/api/v1/bridge/channels', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const body: DiscordChannelListResponse = await deps.bridge.listDiscordChannels();
    return body;
  });
}
