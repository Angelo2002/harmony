import type { FastifyInstance } from 'fastify';
import { Permission, saveMessageSchema, savedQuerySchema, type SavedMessageListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseBody, parseQuery } from '../http/validation.ts';
import type { SavedMessageService } from '../saved/service.ts';

export interface SavedRouteDeps {
  service: SavedMessageService;
}

export function registerSavedRoutes(app: FastifyInstance, deps: SavedRouteDeps): void {
  /**
   * The caller's own saved messages, newest save first, or with `reminders=true`
   * the ones carrying a reminder, soonest first. Saves in channels they can no
   * longer see are left out, not deleted.
   */
  app.get('/api/v1/users/@me/saved', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(savedQuerySchema, request.query);
    const body: SavedMessageListResponse = deps.service.list(auth, query);
    return body;
  });

  /** Saves a message, optionally with a reminder; already saved is fine. */
  app.put('/api/v1/users/@me/saved/:messageId', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { messageId } = request.params as { messageId: string };
    const input = parseBody(saveMessageSchema, request.body ?? undefined);
    return deps.service.save(auth, messageId, input);
  });

  /** Removes a save; not saved is fine. */
  app.delete('/api/v1/users/@me/saved/:messageId', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { messageId } = request.params as { messageId: string };
    deps.service.unsave(auth, messageId);
    return reply.status(204).send();
  });
}
