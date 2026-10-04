import type { FastifyInstance } from 'fastify';
import { serverLogQuerySchema, type ServerLogListResponse } from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import { parseQuery } from '../http/validation.ts';
import type { ServerLogService } from '../log/service.ts';

export interface ServerLogRouteDeps {
  serverLog: ServerLogService;
}

export function registerServerLogRoutes(app: FastifyInstance, deps: ServerLogRouteDeps): void {
  /**
   * The instance's own log, newest first.
   *
   * Owner only, not Administrator: entries can carry internals — a filesystem
   * path, a failed SQL statement, the address a request was made to — that a
   * moderated administrator should not necessarily see. The owner is the one
   * account that already stands in for whoever runs the machine.
   */
  app.get('/api/v1/server-log', async (request) => {
    const auth = requireAuth(request);
    if (!auth.user.isOwner) {
      throw new HttpError(403, 'owner_only', 'Only the owner can read the server log.');
    }

    const query = parseQuery(serverLogQuerySchema, request.query);
    const body: ServerLogListResponse = deps.serverLog.list(query);
    return body;
  });

  /**
   * Empties the log. The clear is deliberately not recorded itself, so that
   * "cleared it" means the log really is empty.
   */
  app.delete('/api/v1/server-log', async (request, reply) => {
    const auth = requireAuth(request);
    if (!auth.user.isOwner) {
      throw new HttpError(403, 'owner_only', 'Only the owner can clear the server log.');
    }

    deps.serverLog.clear();
    return reply.status(204).send();
  });
}
