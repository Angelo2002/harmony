import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  permissionsToString,
  type MemberListResponse,
  type MemberSummary,
  type UserDirectoryResponse,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { assignRole, findRole, listMemberRoles, unassignRole } from '../db/roles.ts';
import { findUserById, listUsers, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface MemberRouteDeps {
  db: Database;
  hub: GatewayHub;
}

export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const { db, hub } = deps;

  app.get('/api/v1/members', async (request) => {
    requirePermission(request, Permission.ManageRoles);
    const rolesByUser = listMemberRoles(db.sqlite);

    const members: MemberSummary[] = listUsers(db.sqlite).map((row) => ({
      user: presentUser(db.sqlite, row),
      roleIds: rolesByUser.get(row.id) ?? [],
      permissions: permissionsToString(resolvePermissions(db.sqlite, row)),
    }));

    const body: MemberListResponse = { members };
    return body;
  });

  /**
   * The public member directory. Every member may read it, because the client
   * needs it to resolve and autocomplete `@username` mentions; it deliberately
   * carries no roles or permissions, unlike the management view above.
   */
  app.get('/api/v1/members/directory', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const body: UserDirectoryResponse = {
      users: listUsers(db.sqlite).map((row) => presentUser(db.sqlite, row)),
    };
    return body;
  });

  app.put('/api/v1/members/:userId/roles/:roleId', async (request, reply) => {
    requirePermission(request, Permission.ManageRoles);
    const { userId, roleId } = request.params as { userId: string; roleId: string };

    if (!findUserById(db.sqlite, userId)) {
      throw new HttpError(404, 'user_not_found', 'That member does not exist.');
    }

    const role = findRole(db.sqlite, roleId);
    if (!role) throw new HttpError(404, 'role_not_found', 'That role does not exist.');
    if (role.is_default === 1) {
      throw new HttpError(400, 'default_role', 'Everyone already has the @everyone role.');
    }

    assignRole(db.sqlite, userId, roleId);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId/roles/:roleId', async (request, reply) => {
    requirePermission(request, Permission.ManageRoles);
    const { userId, roleId } = request.params as { userId: string; roleId: string };

    unassignRole(db.sqlite, userId, roleId);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    return reply.status(204).send();
  });
}
