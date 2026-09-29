import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayCloseCode,
  GatewayEvent,
  Permission,
  hasPermission,
  type Ban,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import type { AuthContext } from '../auth/service.ts';
import { deleteBan, findBan, insertBan, listBans } from '../db/bans.ts';
import { deleteSessionsForUser } from '../db/sessions.ts';
import { findUserById, presentUser, setUserTimeout, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface ModerationService {
  timeoutMember(actor: AuthContext, targetId: string, durationMinutes: number): void;
  clearTimeout(actor: AuthContext, targetId: string): void;
  kickMember(actor: AuthContext, targetId: string): void;
  banMember(actor: AuthContext, targetId: string, reason: string | null): void;
  unbanMember(targetId: string): void;
  listBans(): Ban[];
}

export interface ModerationDeps {
  sqlite: DatabaseSync;
  hub: GatewayHub;
}

export function createModerationService(deps: ModerationDeps): ModerationService {
  const { sqlite, hub } = deps;

  /**
   * Every moderation action shares the same target rules. A full role hierarchy
   * is deliberately not modelled: the only protection is that nobody holding
   * Administrator can be moderated, which keeps roles flat and predictable.
   */
  function requireTarget(actor: AuthContext, targetId: string): UserRow {
    const target = findUserById(sqlite, targetId);
    if (!target) throw new HttpError(404, 'user_not_found', 'That member does not exist.');
    if (target.id === actor.user.id) {
      throw new HttpError(400, 'cannot_moderate_self', 'You cannot moderate yourself.');
    }
    if (target.is_bot === 1) {
      throw new HttpError(400, 'cannot_moderate_bot', 'Discord stand-in accounts cannot be moderated.');
    }
    if (hasPermission(resolvePermissions(sqlite, target), Permission.Administrator)) {
      throw new HttpError(
        403,
        'target_is_admin',
        'Administrators cannot be moderated. Remove their admin role first.',
      );
    }
    return target;
  }

  /** Member state changed, so clients refetch their roster and their own profile. */
  function announceMember(userId: string): void {
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
  }

  return {
    timeoutMember(actor, targetId, durationMinutes) {
      const target = requireTarget(actor, targetId);
      const until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      setUserTimeout(sqlite, target.id, until);
      announceMember(target.id);
    },

    clearTimeout(actor, targetId) {
      const target = requireTarget(actor, targetId);
      setUserTimeout(sqlite, target.id, null);
      announceMember(target.id);
    },

    kickMember(actor, targetId) {
      const target = requireTarget(actor, targetId);
      // A kick ends their sessions and live connections; they may log back in.
      deleteSessionsForUser(sqlite, target.id);
      hub.disconnectUser(target.id, GatewayCloseCode.Removed, 'You were removed from this server.');
      announceMember(target.id);
    },

    banMember(actor, targetId, reason) {
      const target = requireTarget(actor, targetId);
      insertBan(sqlite, {
        userId: target.id,
        bannedBy: actor.user.id,
        reason: reason && reason.length > 0 ? reason : null,
        createdAt: new Date().toISOString(),
      });
      deleteSessionsForUser(sqlite, target.id);
      hub.disconnectUser(target.id, GatewayCloseCode.Removed, 'You were banned from this server.');
      announceMember(target.id);
    },

    unbanMember(targetId) {
      if (!findBan(sqlite, targetId)) {
        throw new HttpError(404, 'not_banned', 'That member is not banned.');
      }
      deleteBan(sqlite, targetId);
      announceMember(targetId);
    },

    listBans() {
      const bans: Ban[] = [];
      for (const row of listBans(sqlite)) {
        const user = findUserById(sqlite, row.user_id);
        if (!user) continue;
        const bannedBy = row.banned_by ? findUserById(sqlite, row.banned_by) : null;
        bans.push({
          user: presentUser(sqlite, user),
          bannedBy: bannedBy ? presentUser(sqlite, bannedBy) : null,
          reason: row.reason,
          createdAt: row.created_at,
        });
      }
      return bans;
    },
  };
}
