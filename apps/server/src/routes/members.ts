import type { FastifyInstance } from 'fastify';
import {
  GatewayCloseCode,
  GatewayEvent,
  Permission,
  adminUpdateUserSchema,
  banSchema,
  permissionsToString,
  timeoutSchema,
  type BanListResponse,
  type MemberListResponse,
  type MemberRosterEntry,
  type MemberRosterResponse,
  type MemberSummary,
  type MemberUpdateResponse,
  type UserDirectoryResponse,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requirePermission } from '../auth/plugin.ts';
import type { AuditService } from '../audit/service.ts';
import type { BridgeService } from '../bridge/service.ts';
import type { Database } from '../db/index.ts';
import { assignRole, findRole, listMemberRoles, unassignRole } from '../db/roles.ts';
import { deleteSessionsForUser } from '../db/sessions.ts';
import { findUserById, listUsers, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { ModerationService } from '../moderation/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { UserService } from '../users/service.ts';

export interface MemberRouteDeps {
  db: Database;
  hub: GatewayHub;
  moderation: ModerationService;
  audit: AuditService;
  users: UserService;
  bridge: BridgeService;
}

export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const { db, hub, moderation, audit, users } = deps;

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
    // A stand-in account is never connected here, so its presence comes from
    // Discord instead, via the bridge.
    const discordOnline = deps.bridge.onlineDiscordIds();

    const members: MemberRosterEntry[] = listUsers(db.sqlite).map((row) => ({
      user: presentUser(db.sqlite, row),
      roleIds: rolesByUser.get(row.id) ?? [],
      online: online.has(row.id) || (row.discord_id !== null && discordOnline.has(row.discord_id)),
    }));

    const body: MemberRosterResponse = { members };
    return body;
  });

  app.put('/api/v1/members/:userId/roles/:roleId', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageRoles);
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
    audit.roleChange(auth.user.id, userId, roleId, true);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId/roles/:roleId', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageRoles);
    const { userId, roleId } = request.params as { userId: string; roleId: string };

    unassignRole(db.sqlite, userId, roleId);
    audit.roleChange(auth.user.id, userId, roleId, false);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    return reply.status(204).send();
  });

  // ---- Account editing ----
  //
  // Editing an account is how a forgotten password is reset: nobody can read a
  // password, but an administrator can set a new one. Any member may be edited,
  // including another administrator, because the flat role model offers no safe
  // alternative and the owner must stay recoverable. Every change is logged.

  /** Sets a member's username, display name, password and/or Discord link. */
  app.patch('/api/v1/members/:userId', async (request) => {
    const auth = requirePermission(request, Permission.ManageMembers);
    const { userId } = request.params as { userId: string };
    const input = parseBody(adminUpdateUserSchema, request.body);

    const fields: string[] = [];
    if (input.username !== undefined) fields.push('username');
    if (input.displayName !== undefined) fields.push('display name');
    if (input.discordId !== undefined) fields.push('Discord link');

    const row = await users.adminUpdate(userId, input);
    if (fields.length > 0) audit.memberUpdated(auth.user.id, userId, fields);

    // A reset ends their sessions; they sign back in with the password they were given.
    if (input.password !== undefined) {
      deleteSessionsForUser(db.sqlite, userId);
      hub.disconnectUser(
        userId,
        GatewayCloseCode.AuthenticationFailed,
        'An administrator reset your password.',
      );
      audit.passwordReset(auth.user.id, userId);
    }

    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    const body: MemberUpdateResponse = { user: presentUser(db.sqlite, row) };
    return body;
  });

  /** Replaces a member's profile picture, for an administrator. */
  app.put('/api/v1/members/:userId/avatar', async (request) => {
    const auth = requirePermission(request, Permission.ManageMembers);
    const { userId } = request.params as { userId: string };

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }
    const file = await request.file();
    if (!file) throw new HttpError(400, 'file_required', 'No image was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new HttpError(413, 'payload_too_large', 'That image is too large.');
    }

    const row = await users.updateAvatar(userId, { contentType: file.mimetype, data });
    audit.memberUpdated(auth.user.id, userId, ['profile picture']);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    const body: MemberUpdateResponse = { user: presentUser(db.sqlite, row) };
    return body;
  });

  /** Clears a member's profile picture, for an administrator. */
  app.delete('/api/v1/members/:userId/avatar', async (request) => {
    const auth = requirePermission(request, Permission.ManageMembers);
    const { userId } = request.params as { userId: string };

    const row = users.clearAvatar(userId);
    audit.memberUpdated(auth.user.id, userId, ['profile picture']);
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
    const body: MemberUpdateResponse = { user: presentUser(db.sqlite, row) };
    return body;
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
    const auth = requirePermission(request, Permission.BanMembers);
    const { userId } = request.params as { userId: string };
    moderation.unbanMember(auth, userId);
    return reply.status(204).send();
  });

  app.get('/api/v1/bans', async (request) => {
    requirePermission(request, Permission.BanMembers);
    const body: BanListResponse = { bans: moderation.listBans() };
    return body;
  });
}
