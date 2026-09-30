import type { FastifyInstance } from 'fastify';
import { Permission, searchQuerySchema } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseQuery } from '../http/validation.ts';
import type { MessageService } from '../messages/service.ts';

export interface SearchRouteDeps {
  service: MessageService;
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  /**
   * Searches message text across every channel the caller can see, newest match
   * first. The same page cursor as the history reader pages through the results.
   */
  app.get('/api/v1/search', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(searchQuerySchema, request.query);
    return deps.service.search(auth, query);
  });
}
