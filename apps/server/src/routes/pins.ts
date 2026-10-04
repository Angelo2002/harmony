import type { FastifyInstance } from 'fastify';
import { Permission, type PinListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { PinService } from '../pins/service.ts';

export interface PinRouteDeps {
  service: PinService;
}

export function registerPinRoutes(app: FastifyInstance, deps: PinRouteDeps): void {
  /** A channel's pins, newest pin first. Locked channels are refused like history. */
  app.get('/api/v1/channels/:id/pins', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const body: PinListResponse = deps.service.list(auth, id);
    return body;
  });

  /** Pins a message; already pinned is fine. Returns the message with its pin time. */
  app.put('/api/v1/channels/:id/pins/:messageId', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id, messageId } = request.params as { id: string; messageId: string };
    return deps.service.pin(auth, id, messageId);
  });

  /** Unpins a message; not pinned is fine. */
  app.delete('/api/v1/channels/:id/pins/:messageId', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id, messageId } = request.params as { id: string; messageId: string };
    deps.service.unpin(auth, id, messageId);
    return reply.status(204).send();
  });
}
