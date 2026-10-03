import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  createRoleSchema,
  hasPermission,
  moveSchema,
  permissionsFromString,
  permissionsToString,
  updateRoleSchema,
  type PermissionValue,
  type RoleListResponse,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import {
  deleteRole,
  findRole,
  insertRole,
  listRoles,
  moveRole,
  nextRolePosition,
  toRole,
  updateRole,
  type RoleRow,
} from '../db/roles.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface RoleRouteDeps {
  db: Database;
  hub: GatewayHub;
}

export function registerRoleRoutes(app: FastifyInstance, deps: RoleRouteDeps): void {
  const { db, hub } = deps;

  function requireRoleRow(id: string): RoleRow {
    const row = findRole(db.sqlite, id);
    if (!row) throw new HttpError(404, 'role_not_found', 'That role does not exist.');
    return row;
  }

  /**
   * Anti-escalation guard: without Administrator you cannot hand out a
   * permission you do not hold yourself.
   */
  function assertCanGrant(auth: AuthContext, permissions: PermissionValue): void {
    if (hasPermission(auth.permissions, Permission.Administrator)) return;
    if ((permissions & ~auth.permissions) !== 0n) {
      throw new HttpError(403, 'permission_escalation', 'You cannot grant permissions you do not have.');
    }
  }

  app.get('/api/v1/roles', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const body: RoleListResponse = { roles: listRoles(db.sqlite).map(toRole) };
    return body;
  });

  app.post('/api/v1/roles', async (request) => {
    const auth = requirePermission(request, Permission.ManageRoles);
    const input = parseBody(createRoleSchema, request.body);

    const permissions = input.permissions ? permissionsFromString(input.permissions) : 0n;
    assertCanGrant(auth, permissions);

    const id = randomUUID();
    insertRole(db.sqlite, {
      id,
      name: input.name,
      color: input.color ?? null,
      position: nextRolePosition(db.sqlite),
      permissions: permissionsToString(permissions),
      hoist: input.hoist ?? false,
      mentionable: input.mentionable ?? false,
      badge: input.badge ?? 'none',
      createdAt: new Date().toISOString(),
    });

    const role = toRole(requireRoleRow(id));
    hub.dispatch(GatewayEvent.RoleCreate, role);
    return role;
  });

  app.patch('/api/v1/roles/:id', async (request) => {
    const auth = requirePermission(request, Permission.ManageRoles);
    const { id } = request.params as { id: string };
    const row = requireRoleRow(id);
    const input = parseBody(updateRoleSchema, request.body);

    if (row.is_default === 1 && input.name !== undefined) {
      throw new HttpError(403, 'immutable_role', 'The @everyone role cannot be renamed.');
    }
    if (input.permissions !== undefined) assertCanGrant(auth, permissionsFromString(input.permissions));

    updateRole(db.sqlite, id, {
      name: input.name,
      color: input.color,
      permissions: input.permissions,
      hoist: input.hoist,
      mentionable: input.mentionable,
      badge: input.badge,
    });

    const role = toRole(requireRoleRow(id));
    hub.dispatch(GatewayEvent.RoleUpdate, role);
    return role;
  });

  /** Moves a role one step up or down. Positions are display-only. */
  app.post('/api/v1/roles/:id/move', async (request) => {
    requirePermission(request, Permission.ManageRoles);
    const { id } = request.params as { id: string };
    const row = requireRoleRow(id);

    if (row.is_default === 1) {
      throw new HttpError(403, 'immutable_role', 'The @everyone role cannot be reordered.');
    }

    const input = parseBody(moveSchema, request.body);
    moveRole(db.sqlite, id, input.direction);

    const body: RoleListResponse = { roles: listRoles(db.sqlite).map(toRole) };
    hub.dispatch(GatewayEvent.RoleUpdate, { id });
    return body;
  });

  app.delete('/api/v1/roles/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageRoles);
    const { id } = request.params as { id: string };
    const row = requireRoleRow(id);

    if (row.is_default === 1) {
      throw new HttpError(403, 'immutable_role', 'The @everyone role cannot be deleted.');
    }

    deleteRole(db.sqlite, id);
    hub.dispatch(GatewayEvent.RoleDelete, { id });
    return reply.status(204).send();
  });
}
