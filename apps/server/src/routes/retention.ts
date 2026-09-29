import type { FastifyInstance } from 'fastify';
import {
  Permission,
  updateRetentionSchema,
  type RetentionResponse,
  type RetentionRunResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseBody } from '../http/validation.ts';
import type { Pruner } from '../retention/pruner.ts';
import type { SettingsService } from '../settings/service.ts';

export interface RetentionRouteDeps {
  settings: SettingsService;
  pruner: Pruner;
}

export function registerRetentionRoutes(app: FastifyInstance, deps: RetentionRouteDeps): void {
  function snapshot(): RetentionResponse {
    return {
      settings: deps.settings.getRetention(),
      usage: deps.pruner.usage(),
      lastRun: deps.pruner.lastRun(),
    };
  }

  app.get('/api/v1/retention', async (request) => {
    requirePermission(request, Permission.ManageServer);
    return snapshot();
  });

  app.patch('/api/v1/retention', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(updateRetentionSchema, request.body);
    deps.settings.updateRetention(input);
    return snapshot();
  });

  app.post('/api/v1/retention/run', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const body: RetentionRunResponse = { summary: deps.pruner.runNow(), usage: deps.pruner.usage() };
    return body;
  });
}
