import type { FastifyInstance } from 'fastify';
import { Permission, mediaQuerySchema, type MediaListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseQuery } from '../http/validation.ts';
import type { MediaService } from '../media/service.ts';

export interface MediaRouteDeps {
  service: MediaService;
}

/**
 * The admin media gallery. The attachment delete lives here rather than with the
 * upload/read routes because it is a gallery action: it also reclaims the stored
 * bytes once nothing else references them.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  app.get('/api/v1/media', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const query = parseQuery(mediaQuerySchema, request.query);
    const body: MediaListResponse = deps.service.list(query);
    return body;
  });

  app.delete('/api/v1/attachments/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageServer);
    const { id } = request.params as { id: string };
    deps.service.remove(id);
    return reply.status(204).send();
  });
}
