import type { FastifyInstance } from 'fastify';
import { Permission, permissionsToString, type MemberListResponse, type MemberSummary } from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { assignRole, findRole, listMemberRoles, unassignRole } from '../db/roles.ts';
import { findUserById, listUsers, toUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';

export function registerMemberRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/v1/members', async (request) => {
    requirePermission(request, Permission.ManageRoles);
    const rolesByUser = listMemberRoles(db.sqlite);

    const members: MemberSummary[] = listUsers(db.sqlite).map((row) => ({
      user: toUser(row),
      roleIds: rolesByUser.get(row.id) ?? [],
      permissions: permissionsToString(resolvePermissions(db.sqlite, row)),
    }));

    const body: MemberListResponse = { members };
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
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId/roles/:roleId', async (request, reply) => {
    requirePermission(request, Permission.ManageRoles);
    const { userId, roleId } = request.params as { userId: string; roleId: string };

    unassignRole(db.sqlite, userId, roleId);
    return reply.status(204).send();
  });
}
