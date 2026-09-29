import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditDetail, AuditEntry, AuditKind, AuditListResponse, AuditQuery, User } from '@harmony/shared';
import { clearAudit, insertAudit, listAudit } from '../db/audit.ts';
import { findChannel } from '../db/channels.ts';
import { findRole } from '../db/roles.ts';
import { findUserById, presentUser } from '../db/users.ts';

/** The moderation kinds, kept narrow so a typo cannot invent a new one. */
export type ModerationAuditKind = 'timeout_add' | 'timeout_clear' | 'kick' | 'ban' | 'unban';

/** The minimal identity of an image kept alongside a deleted message. */
export interface AuditImage {
  id: string;
  filename: string;
}

/**
 * The admin audit log. It records what was done, by whom and to whom, and keeps
 * a snapshot of message text so a deletion or an edit can still be reviewed
 * afterwards.
 *
 * Entries are append-only and never edited. Names and the channel are captured
 * at the time of the action, so an entry stays readable once a role is renamed,
 * a channel is deleted or an account is removed.
 */
export interface AuditService {
  /** Records a deletion, with the text and images that went with it. */
  messageDeleted(actorId: string, channelId: string, content: string, attachments: AuditImage[]): void;
  /** Records an edit, with the text either side of it. */
  messageEdited(actorId: string, channelId: string, before: string, after: string): void;
  /** Records an image being deleted from the media gallery. */
  mediaDeleted(actorId: string, filename: string, channelName: string | null): void;
  moderation(kind: ModerationAuditKind, actorId: string, targetId: string, detail?: AuditDetail): void;
  /** Records a role being handed out or taken away. */
  roleChange(actorId: string, targetId: string, roleId: string, added: boolean): void;
  /** Records an administrator editing a member's account fields. */
  memberUpdated(actorId: string, targetId: string, fields: string[]): void;
  /** Records an administrator setting a member's password. */
  passwordReset(actorId: string, targetId: string): void;
  list(query: AuditQuery): AuditListResponse;
  /** Empties the log, returning how many entries were removed. */
  clear(): number;
}

export function createAuditService(sqlite: DatabaseSync): AuditService {
  function userName(id: string | null): string | undefined {
    if (!id) return undefined;
    const row = findUserById(sqlite, id);
    return row ? (row.display_name ?? row.username) : undefined;
  }

  function present(id: string | null): User | null {
    if (!id) return null;
    const row = findUserById(sqlite, id);
    return row ? presentUser(sqlite, row) : null;
  }

  function write(
    kind: AuditKind,
    actorId: string | null,
    targetId: string | null,
    channelId: string | null,
    detail: AuditDetail,
  ): void {
    insertAudit(sqlite, {
      id: randomUUID(),
      kind,
      actorId,
      targetId,
      channelId,
      detail: JSON.stringify(detail),
      createdAt: new Date().toISOString(),
    });
  }

  function parseDetail(raw: string): AuditDetail {
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === 'object' ? (value as AuditDetail) : {};
    } catch {
      return {};
    }
  }

  return {
    messageDeleted(actorId, channelId, content, attachments) {
      write('message_delete', actorId, null, channelId, {
        channelName: findChannel(sqlite, channelId)?.name,
        actorName: userName(actorId),
        before: content,
        // Images still exist after a soft delete, so the log can show them.
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    },

    messageEdited(actorId, channelId, before, after) {
      write('message_edit', actorId, null, channelId, {
        channelName: findChannel(sqlite, channelId)?.name,
        actorName: userName(actorId),
        before,
        after,
      });
    },

    mediaDeleted(actorId, filename, channelName) {
      write('media_delete', actorId, null, null, {
        filename,
        channelName: channelName ?? undefined,
        actorName: userName(actorId),
      });
    },

    moderation(kind, actorId, targetId, detail = {}) {
      write(kind, actorId, targetId, null, {
        ...detail,
        actorName: userName(actorId),
        targetName: userName(targetId),
      });
    },

    roleChange(actorId, targetId, roleId, added) {
      write(added ? 'role_add' : 'role_remove', actorId, targetId, null, {
        roleName: findRole(sqlite, roleId)?.name,
        actorName: userName(actorId),
        targetName: userName(targetId),
      });
    },

    memberUpdated(actorId, targetId, fields) {
      write('member_update', actorId, targetId, null, {
        fields,
        actorName: userName(actorId),
        targetName: userName(targetId),
      });
    },

    passwordReset(actorId, targetId) {
      write('password_reset', actorId, targetId, null, {
        actorName: userName(actorId),
        targetName: userName(targetId),
      });
    },

    list(query) {
      const rows = listAudit(sqlite, { limit: query.limit, before: query.before, beforeId: query.beforeId });
      const entries: AuditEntry[] = rows.map((row) => ({
        id: row.id,
        kind: row.kind as AuditKind,
        actor: present(row.actor_id),
        target: present(row.target_id),
        createdAt: row.created_at,
        detail: parseDetail(row.detail),
      }));
      return { entries };
    },

    clear() {
      return clearAudit(sqlite);
    },
  };
}
