import type { FastifyInstance } from 'fastify';
import {
  Permission,
  bridgeImportSchema,
  bridgeTestSchema,
  updateBridgeSchema,
  type BridgeImportResponse,
  type BridgeResponse,
  type DiscordChannelListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { BridgeService } from '../bridge/service.ts';
import { HttpError } from '../http/errors.ts';
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

  /** Sends a test message so an admin can see exactly what Discord says. */
  app.post('/api/v1/bridge/test', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(bridgeTestSchema, request.body);

    try {
      await deps.bridge.testMirror(input.channelId);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Surface the underlying Discord error verbatim.
      throw new HttpError(502, 'bridge_test_failed', error instanceof Error ? error.message : String(error));
    }

    return { ok: true };
  });

  /** Pulls recent Discord history into a bridged channel. Idempotent. */
  app.post('/api/v1/bridge/import', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(bridgeImportSchema, request.body);
    const body: BridgeImportResponse = { imported: await deps.bridge.importChannel(input.channelId, input.limit) };
    return body;
  });
}
