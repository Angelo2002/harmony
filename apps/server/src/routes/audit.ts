import type { FastifyInstance } from 'fastify';
import { Permission, auditQuerySchema, type AuditListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { AuditService } from '../audit/service.ts';
import { parseQuery } from '../http/validation.ts';

export interface AuditRouteDeps {
  audit: AuditService;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  /**
   * The admin audit log, newest first. Reading it is deliberately restricted to
   * `ManageServer` rather than any moderation flag, since message text that was
   * deleted from a channel can be read back from here.
   */
  app.get('/api/v1/audit', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const query = parseQuery(auditQuerySchema, request.query);
    const body: AuditListResponse = deps.audit.list(query);
    return body;
  });

  /**
   * Empties the log. The clear is deliberately not recorded itself, so that
   * "cleared it" means the log really is empty.
   */
  app.delete('/api/v1/audit', async (request, reply) => {
    requirePermission(request, Permission.ManageServer);
    deps.audit.clear();
    return reply.status(204).send();
  });
}
