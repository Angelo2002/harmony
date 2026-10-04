import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  type SaveMessageInput,
  type SavedMessage,
  type SavedMessageListResponse,
  type SavedMessageUpdatePayload,
  type SavedQuery,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { canAccessChannel, channelAccessFor, visibleChannels } from '../access/service.ts';
import { findMessage, type MessageRow } from '../db/messages.ts';
import {
  findSavedMessage,
  listSavedMessages,
  listSavedReminders,
  saveMessage,
  unsaveMessage,
  type SavedMessageRow,
} from '../db/saved_messages.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** How far in the past a reminder may be set, to forgive a slow request or a skewed clock. */
const REMINDER_GRACE_MS = 60_000;

/**
 * Saved messages: Discord's bookmarks, one member's private list of messages to
 * come back to, optionally with a reminder.
 *
 * Everything here is about the caller's own saves and nobody else's. A change
 * goes out only to the caller's other sessions, never to the channel, so saving
 * a message tells its author and everyone else nothing.
 *
 * A save is checked against what the member can see when it is made and every
 * time the list is read, not kept in step with it: losing a role hides the save
 * rather than deleting it, so it is back if the role is. A deleted message is
 * dropped from the list, the same as it drops out of the pins; there is nothing
 * left to jump to, and a "deleted" placeholder would only be clutter.
 */
export interface SavedMessageService {
  /** The caller's saves, newest first, or their reminders soonest first. */
  list(auth: AuthContext, query: SavedQuery): SavedMessageListResponse;
  /** Saves a message the caller can see. Saving it again changes only the reminder, if given. */
  save(auth: AuthContext, messageId: string, input: SaveMessageInput): SavedMessage;
  /** Removes a save. Removing one that is not saved changes nothing. */
  unsave(auth: AuthContext, messageId: string): void;
}

export function createSavedMessageService(
  sqlite: DatabaseSync,
  hub: GatewayHub,
  messages: MessageService,
): SavedMessageService {
  function visibleChannelIds(userId: string): string[] {
    return visibleChannels(sqlite, channelAccessFor(sqlite, userId)).map((channel) => channel.id);
  }

  /**
   * A live message the caller may read. One in a channel locked away from them
   * is reported as missing rather than forbidden: the save route names no
   * channel, so a 403 would confirm that a message they cannot see exists.
   */
  function requireVisibleMessage(userId: string, messageId: string): MessageRow {
    const row = findMessage(sqlite, messageId);
    if (!row || row.deleted_at || !canAccessChannel(sqlite, channelAccessFor(sqlite, userId), row.channel_id)) {
      throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    }
    return row;
  }

  /** Stored as a plain UTC ISO string, so the reminder queries can compare text. */
  function normalizeReminder(remindAt: string | null | undefined): string | null | undefined {
    if (remindAt === undefined || remindAt === null) return remindAt;
    const time = Date.parse(remindAt);
    if (time < Date.now() - REMINDER_GRACE_MS) {
      throw new HttpError(400, 'invalid_reminder', 'A reminder has to be in the future.');
    }
    return new Date(time).toISOString();
  }

  function present(row: SavedMessageRow, viewerId: string): SavedMessage | null {
    const message = messages.byId(row.id, viewerId);
    return message ? { message, savedAt: row.saved_at, remindAt: row.remind_at } : null;
  }

  /** Tells the caller's own sessions, and only them, what became of a save. */
  function notify(userId: string, payload: SavedMessageUpdatePayload): void {
    hub.dispatchToUsers(GatewayEvent.SavedMessageUpdate, payload, new Set([userId]));
  }

  return {
    list(auth, query) {
      const visible = visibleChannelIds(auth.user.id);
      const rows =
        query.reminders === 'true'
          ? listSavedReminders(sqlite, auth.user.id, visible, query.limit)
          : listSavedMessages(sqlite, auth.user.id, visible, {
              limit: query.limit,
              before: query.before,
              beforeId: query.beforeId,
            });
      return { saved: rows.flatMap((row) => present(row, auth.user.id) ?? []) };
    },

    save(auth, messageId, input) {
      const row = requireVisibleMessage(auth.user.id, messageId);
      const remindAt = normalizeReminder(input?.remindAt);
      const changed = saveMessage(sqlite, {
        userId: auth.user.id,
        messageId: row.id,
        savedAt: new Date().toISOString(),
        remindAt,
      });

      const stored = findSavedMessage(sqlite, auth.user.id, row.id);
      const message = messages.byId(row.id, auth.user.id);
      if (!stored || !message) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
      const saved: SavedMessage = { message, savedAt: stored.saved_at, remindAt: stored.remind_at };
      if (changed) notify(auth.user.id, { messageId: row.id, channelId: row.channel_id, saved });
      return saved;
    },

    unsave(auth, messageId) {
      // No visibility check: a member may always let go of their own save, even
      // one for a message they can no longer read.
      const row = findMessage(sqlite, messageId);
      if (!unsaveMessage(sqlite, auth.user.id, messageId)) return;
      // A hard-deleted message leaves no row to read a channel from. The
      // `SavedMessageUpdatePayload` contract requires a channelId, and an empty
      // one cannot be routed by a client, so the update is skipped rather than
      // sent with a made-up channel.
      if (!row) return;
      notify(auth.user.id, { messageId, channelId: row.channel_id, saved: null });
    },
  };
}
