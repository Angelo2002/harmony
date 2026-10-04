import type { DatabaseSync } from 'node:sqlite';
import { GatewayEvent, LIMITS, Permission, hasPermission, type Message, type PinListResponse } from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { AuditService } from '../audit/service.ts';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { findChannel } from '../db/channels.ts';
import { findMessage, type MessageRow } from '../db/messages.ts';
import { clearPinned, countPinnedMessages, listPinnedMessages, setPinned } from '../db/pins.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/**
 * Pinned messages, per channel.
 *
 * The pin state rides on the message itself (`Message.pinnedAt`), so a change
 * goes out as an ordinary MESSAGE_UPDATE that every client already applies; there
 * is no pin event of its own. That broadcast goes straight to the hub rather than
 * through the message service's edit path, so a pin is never mistaken for an edit
 * and mirrored to Discord as one.
 *
 * It is shaped like the message service for the same reason: the Discord bridge
 * is expected to sync pins later. Local pins notify `onPinned` / `onUnpinned`,
 * which the bridge can subscribe to and pin on Discord; pins that came from
 * Discord go through the `*Bridged` variants, which skip permission checks and
 * notify nobody, so a pin can never bounce back and forth between the two.
 */
export interface PinService {
  /** A channel's pins, newest pin first, for a member who can see the channel. */
  list(auth: AuthContext, channelId: string): PinListResponse;
  /** Pins a message. Pinning one that already is changes nothing. Requires ManageMessages. */
  pin(auth: AuthContext, channelId: string, messageId: string): Message;
  /** Unpins a message. Unpinning one that is not pinned changes nothing. Requires ManageMessages. */
  unpin(auth: AuthContext, channelId: string, messageId: string): Message;
  /**
   * Applies a pin made on Discord, without permission checks or notifying the
   * listeners. The cap still applies, so a full channel ignores the pin; null
   * means nothing changed.
   */
  pinBridged(messageId: string, pinnedAt?: string): Message | null;
  /** Applies an unpin made on Discord, without notifying the listeners. */
  unpinBridged(messageId: string): Message | null;
  /** Notified for local pins only, never for bridged ones. */
  onPinned(listener: (message: Message) => void): void;
  onUnpinned(listener: (message: Message) => void): void;
}

export function createPinService(
  sqlite: DatabaseSync,
  hub: GatewayHub,
  audit: AuditService,
  messages: MessageService,
): PinService {
  const pinnedListeners = new Set<(message: Message) => void>();
  const unpinnedListeners = new Set<(message: Message) => void>();

  /** A misbehaving listener must never break the pin itself. */
  function safeNotify(listener: (message: Message) => void, message: Message): void {
    try {
      listener(message);
    } catch (error) {
      void error;
    }
  }

  /**
   * The same rule as reading history: a locked channel is forbidden to anyone
   * without its role, and a missing one is simply not found.
   */
  function assertChannel(userId: string, channelId: string): void {
    if (!findChannel(sqlite, channelId)) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, userId), channelId)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
  }

  /** A live message in the named channel; one from elsewhere is as good as missing. */
  function requireMessage(channelId: string, messageId: string): MessageRow {
    const row = findMessage(sqlite, messageId);
    if (!row || row.deleted_at || row.channel_id !== channelId) {
      throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    }
    return row;
  }

  function assertCanPin(auth: AuthContext): void {
    if (!hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You need Manage Messages to pin or unpin messages.');
    }
  }

  function isFull(channelId: string): boolean {
    return countPinnedMessages(sqlite, channelId) >= LIMITS.pinsPerChannel;
  }

  /** Sends the new pin state to everyone who can see the channel. */
  function broadcast(messageId: string): Message | null {
    const message = messages.byId(messageId);
    if (message) hub.dispatch(GatewayEvent.MessageUpdate, message, { channelId: message.channelId });
    return message;
  }

  function render(messageId: string, viewerId: string): Message {
    const message = messages.byId(messageId, viewerId);
    if (!message) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    return message;
  }

  return {
    list(auth, channelId) {
      assertChannel(auth.user.id, channelId);
      const rows = listPinnedMessages(sqlite, channelId);
      return {
        messages: rows.flatMap((row) => {
          const message = messages.byId(row.id, auth.user.id);
          return message ? [message] : [];
        }),
      };
    },

    pin(auth, channelId, messageId) {
      assertChannel(auth.user.id, channelId);
      const row = requireMessage(channelId, messageId);
      assertCanPin(auth);
      if (row.pinned_at) return render(row.id, auth.user.id);

      if (isFull(channelId)) {
        throw new HttpError(
          400,
          'too_many_pins',
          `This channel already has ${LIMITS.pinsPerChannel} pinned messages. Unpin one before pinning another.`,
        );
      }

      if (setPinned(sqlite, row.id, auth.user.id, new Date().toISOString())) {
        const message = broadcast(row.id);
        audit.messagePinned(auth.user.id, channelId, row.author_id, row.content, true);
        if (message) for (const listener of pinnedListeners) safeNotify(listener, message);
      }
      return render(row.id, auth.user.id);
    },

    unpin(auth, channelId, messageId) {
      assertChannel(auth.user.id, channelId);
      const row = requireMessage(channelId, messageId);
      assertCanPin(auth);

      if (clearPinned(sqlite, row.id)) {
        const message = broadcast(row.id);
        audit.messagePinned(auth.user.id, channelId, row.author_id, row.content, false);
        if (message) for (const listener of unpinnedListeners) safeNotify(listener, message);
      }
      return render(row.id, auth.user.id);
    },

    pinBridged(messageId, pinnedAt) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at || row.pinned_at || isFull(row.channel_id)) return null;
      // Nobody here pinned it, so there is no one to credit.
      if (!setPinned(sqlite, row.id, null, pinnedAt ?? new Date().toISOString())) return null;
      return broadcast(row.id);
    },

    unpinBridged(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;
      if (!clearPinned(sqlite, row.id)) return null;
      return broadcast(row.id);
    },

    onPinned(listener) {
      pinnedListeners.add(listener);
    },

    onUnpinned(listener) {
      unpinnedListeners.add(listener);
    },
  };
}
