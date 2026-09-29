import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Permission, createInviteSchema } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { findInvite, insertInvite, listInvites, toInvite, deleteInvite } from '../db/invites.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';

export function registerInviteRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/v1/invites', async (request) => {
    // Anyone with `CreateInvites` may mint codes, but seeing every invite is a management view.
    requirePermission(request, Permission.ManageServer);
    return { invites: listInvites(db.sqlite).map(toInvite) };
  });

  app.post('/api/v1/invites', async (request) => {
    const auth = requirePermission(request, Permission.CreateInvites);
    const input = parseBody(createInviteSchema, request.body ?? {});

    const code = randomBytes(6).toString('base64url');
    const expiresAt = input.expiresInHours
      ? new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString()
      : null;

    insertInvite(db.sqlite, {
      code,
      createdBy: auth.user.id,
      createdAt: new Date().toISOString(),
      expiresAt,
      maxUses: input.maxUses ?? null,
    });

    const invite = findInvite(db.sqlite, code);
    if (!invite) throw new HttpError(500, 'internal_error', 'Failed to create the invite.');
    return toInvite(invite);
  });

  app.delete('/api/v1/invites/:code', async (request, reply) => {
    requirePermission(request, Permission.ManageServer);
    const { code } = request.params as { code: string };
    deleteInvite(db.sqlite, code);
    return reply.status(204).send();
  });
}
