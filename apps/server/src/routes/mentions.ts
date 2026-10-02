import type { FastifyInstance } from 'fastify';
import { Permission, mentionQuerySchema, type MentionListResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseQuery } from '../http/validation.ts';
import type { MessageService } from '../messages/service.ts';

export interface MentionRouteDeps {
  service: MessageService;
}

export function registerMentionRoutes(app: FastifyInstance, deps: MentionRouteDeps): void {
  /**
   * The caller's own inbox: every message that named them or answered theirs,
   * newest first. Only channels they can see are included, so a locked channel
   * never leaks through it, and it is private — one member's list, not a record
   * anyone else can read.
   */
  app.get('/api/v1/mentions', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(mentionQuerySchema, request.query);
    const body: MentionListResponse = deps.service.mentions(auth, query);
    return body;
  });
}
