import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  banSchema,
  permissionsToString,
  timeoutSchema,
  type BanListResponse,
  type MemberListResponse,
  type MemberRosterEntry,
  type MemberRosterResponse,
  type MemberSummary,
  type UserDirectoryResponse,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { assignRole, findRole, listMemberRoles, unassignRole } from '../db/roles.ts';
import { findUserById, listUsers, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { ModerationService } from '../moderation/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface MemberRouteDeps {
  db: Database;
  hub: GatewayHub;
  moderation: ModerationService;
}

export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const { db, hub, moderation } = deps;

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

  /**
   * The public roster behind the member list sidebar. Every member may read it,
   * because the sidebar is visible to everyone; it carries role ids and presence
   * but no permissions, unlike the management view above.
   */
  app.get('/api/v1/members/roster', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const rolesByUser = listMemberRoles(db.sqlite);
    const online = hub.onlineUserIds();

    const members: MemberRosterEntry[] = listUsers(db.sqlite).map((row) => ({
      user: presentUser(db.sqlite, row),
      roleIds: rolesByUser.get(row.id) ?? [],
      online: online.has(row.id),
    }));

    const body: MemberRosterResponse = { members };
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

  // ---- Moderation ----
  //
  // Timeouts, kicks and bans all refuse to act on administrators, so a moderator
  // can never be removed by someone below them. There is no other hierarchy.

  /** Applies a timeout: the member keeps read access but cannot post. */
  app.put('/api/v1/members/:userId/timeout', async (request, reply) => {
    const auth = requirePermission(request, Permission.ModerateMembers);
    const { userId } = request.params as { userId: string };
    const input = parseBody(timeoutSchema, request.body);
    moderation.timeoutMember(auth, userId, input.durationMinutes);
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId/timeout', async (request, reply) => {
    const auth = requirePermission(request, Permission.ModerateMembers);
    const { userId } = request.params as { userId: string };
    moderation.clearTimeout(auth, userId);
    return reply.status(204).send();
  });

  /** Ends the member's sessions and connections; they may still log back in. */
  app.post('/api/v1/members/:userId/kick', async (request, reply) => {
    const auth = requirePermission(request, Permission.KickMembers);
    const { userId } = request.params as { userId: string };
    moderation.kickMember(auth, userId);
    return reply.status(204).send();
  });

  /** Bans the member, ending their sessions and blocking future logins. */
  app.put('/api/v1/members/:userId/ban', async (request, reply) => {
    const auth = requirePermission(request, Permission.BanMembers);
    const { userId } = request.params as { userId: string };
    const input = parseBody(banSchema, request.body ?? {});
    moderation.banMember(auth, userId, input.reason ?? null);
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId/ban', async (request, reply) => {
    requirePermission(request, Permission.BanMembers);
    const { userId } = request.params as { userId: string };
    moderation.unbanMember(userId);
    return reply.status(204).send();
  });

  app.get('/api/v1/bans', async (request) => {
    requirePermission(request, Permission.BanMembers);
    const body: BanListResponse = { bans: moderation.listBans() };
    return body;
  });
}
