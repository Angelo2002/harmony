import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  hasPermission,
  type Attachment,
  type Message,
  type MessageDeletePayload,
  type MessageHistoryQuery,
  type MessageListResponse,
  type MessageReference,
  type Reaction,
  type ReactionsClearPayload,
  type ReactionUpdatePayload,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { assertNotTimedOut } from '../auth/guards.ts';
import { attachToMessage, findAttachment, listAttachmentsForMessages } from '../db/attachments.ts';
import { findChannel } from '../db/channels.ts';
import { findEmoji } from '../db/emojis.ts';
import {
  findMessage,
  insertMessage,
  listMessages,
  softDeleteMessage,
  updateMessageContent,
  type MessageRow,
} from '../db/messages.ts';
import {
  countReaction,
  deleteReaction,
  deleteReactionsForEmoji,
  insertReaction,
  listReactionsForMessages,
} from '../db/reactions.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** What the bridge needs to mirror a single reaction change out to Discord. */
export interface ReactionEvent {
  message: Message;
  emoji: string;
  emojiId: string | null;
}

export interface MessageService {
  history(channelId: string, query: MessageHistoryQuery, viewerId: string): MessageListResponse;
  create(
    auth: AuthContext,
    channelId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
  ): Message;
  /** Inserts a message on behalf of the bridge, skipping permission checks. */
  createBridged(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
    createdAt?: string,
  ): Message;
  edit(auth: AuthContext, messageId: string, content: string): Message;
  /** Applies a bridged edit, without notifying the outbound listeners. */
  editBridged(messageId: string, content: string): Message | null;
  remove(auth: AuthContext, messageId: string): void;
  /** Applies a bridged deletion, without notifying the outbound listeners. */
  deleteBridged(messageId: string): void;
  /** Adds the caller's reaction, or removes it if they already reacted. */
  toggleReaction(auth: AuthContext, messageId: string, emoji: string, emojiId: string | null): Message;
  /** Removes every user's reaction of one emoji. Requires ManageMessages. */
  clearReactions(auth: AuthContext, messageId: string, emoji: string, emojiId: string | null): Message;
  /** Bridged variants apply a Discord reaction without permission checks. */
  addReactionBridged(messageId: string, userId: string, emoji: string, emojiId: string | null): void;
  removeReactionBridged(messageId: string, userId: string, emoji: string): void;
  clearReactionsBridged(messageId: string, emoji: string, emojiId: string | null): void;
  /** Notified for locally created messages only, never for bridged ones. */
  onMessageCreated(listener: (message: Message) => void): void;
  onMessageEdited(listener: (message: Message) => void): void;
  onMessageDeleted(listener: (info: MessageDeletePayload) => void): void;
  onReactionAdded(listener: (event: ReactionEvent) => void): void;
  onReactionRemoved(listener: (event: ReactionEvent) => void): void;
  onReactionsCleared(listener: (event: ReactionEvent) => void): void;
}

export function createMessageService(sqlite: DatabaseSync, hub: GatewayHub): MessageService {
  function buildReply(row: MessageRow): MessageReference | null {
    if (!row.reply_to_id) return null;
    const parent = findMessage(sqlite, row.reply_to_id);
    if (!parent) return null;
    const authorRow = parent.author_id ? findUserById(sqlite, parent.author_id) : null;
    return {
      id: parent.id,
      author: authorRow ? presentUser(sqlite, authorRow) : null,
      // A deleted parent keeps its slot, but the text is gone.
      content: parent.deleted_at ? '' : parent.content,
      deleted: parent.deleted_at != null,
    };
  }

  function toMessage(row: MessageRow, attachments: Attachment[], reactions: Reaction[]): Message {
    const authorRow = row.author_id ? findUserById(sqlite, row.author_id) : null;
    return {
      id: row.id,
      channelId: row.channel_id,
      author: authorRow ? presentUser(sqlite, authorRow) : null,
      content: row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      attachments,
      replyTo: buildReply(row),
      reactions,
    };
  }

  function reactionsFor(messageId: string, viewerId: string): Reaction[] {
    return listReactionsForMessages(sqlite, [messageId], viewerId).get(messageId) ?? [];
  }

  function render(row: MessageRow, viewerId: string): Message {
    return toMessage(row, attachmentsFor(row.id), reactionsFor(row.id, viewerId));
  }

  /** Validates a reply target: it must exist, be visible and be in the same channel. */
  function resolveReplyTo(channelId: string, replyToId: string | null): string | null {
    if (!replyToId) return null;
    const parent = findMessage(sqlite, replyToId);
    if (!parent || parent.deleted_at) {
      throw new HttpError(400, 'invalid_reply', 'The message you are replying to no longer exists.');
    }
    if (parent.channel_id !== channelId) {
      throw new HttpError(400, 'invalid_reply', 'You can only reply to a message in the same channel.');
    }
    return parent.id;
  }

  function requireChannel(channelId: string): void {
    if (!findChannel(sqlite, channelId)) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }
  }

  function requireMessage(messageId: string): MessageRow {
    const row = findMessage(sqlite, messageId);
    if (!row || row.deleted_at) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    return row;
  }

  function attachmentsFor(messageId: string): Attachment[] {
    return listAttachmentsForMessages(sqlite, [messageId]).get(messageId) ?? [];
  }

  function isAuthor(auth: AuthContext, row: MessageRow): boolean {
    return row.author_id === auth.user.id;
  }

  /** Like Discord, only the author may change a message's text. */
  function assertCanEdit(auth: AuthContext, row: MessageRow): void {
    if (!isAuthor(auth, row)) {
      throw new HttpError(403, 'forbidden', 'You can only edit your own messages.');
    }
  }

  /** The author, or anyone with Manage Messages, may delete it. */
  function assertCanDelete(auth: AuthContext, row: MessageRow): void {
    if (!isAuthor(auth, row) && !hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You can only delete your own messages.');
    }
  }

  /**
   * Turns a client's reaction target into the canonical stored form. For custom
   * emoji the database name is authoritative, so a stale or spoofed shortcode
   * cannot desync the row from the image it points at.
   */
  function canonicalReaction(emoji: string, emojiId: string | null): { emoji: string; emojiId: string | null } {
    if (!emojiId) return { emoji, emojiId: null };
    const row = findEmoji(sqlite, emojiId);
    if (!row) throw new HttpError(400, 'invalid_emoji', 'That emoji does not exist.');
    return { emoji: `:${row.name}:`, emojiId: row.id };
  }

  function insertWithAttachments(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
    createdAt?: string,
  ): Message {
    // Uploads belong to the message that claims them; reject anything already
    // used or belonging to someone else.
    for (const attachmentId of attachmentIds) {
      const attachment = findAttachment(sqlite, attachmentId);
      if (!attachment) throw new HttpError(400, 'invalid_attachment', 'One of the attachments does not exist.');
      if (attachment.message_id) {
        throw new HttpError(400, 'attachment_in_use', 'One of the attachments is already in use.');
      }
      if (attachment.uploader_id !== authorId) {
        throw new HttpError(403, 'forbidden', 'You can only attach your own uploads.');
      }
    }

    const id = randomUUID();
    insertMessage(sqlite, {
      id,
      channelId,
      authorId,
      content,
      // Imported history keeps its original Discord timestamp.
      createdAt: createdAt ?? new Date().toISOString(),
      replyToId: resolveReplyTo(channelId, replyToId),
    });
    for (const attachmentId of attachmentIds) attachToMessage(sqlite, attachmentId, id);

    // A brand new message has no reactions yet.
    return toMessage(requireMessage(id), attachmentsFor(id), []);
  }

  const createdListeners = new Set<(message: Message) => void>();
  const editedListeners = new Set<(message: Message) => void>();
  const deletedListeners = new Set<(info: MessageDeletePayload) => void>();
  const reactionAddedListeners = new Set<(event: ReactionEvent) => void>();
  const reactionRemovedListeners = new Set<(event: ReactionEvent) => void>();
  const reactionsClearedListeners = new Set<(event: ReactionEvent) => void>();

  /** A misbehaving listener must never break the message operation itself. */
  function safeNotify<T>(listener: (value: T) => void, value: T): void {
    try {
      listener(value);
    } catch (error) {
      void error;
    }
  }

  function announce(message: Message): void {
    hub.dispatch(GatewayEvent.MessageCreate, message);
    for (const listener of createdListeners) safeNotify(listener, message);
  }

  function announceEdit(message: Message): void {
    hub.dispatch(GatewayEvent.MessageUpdate, message);
    for (const listener of editedListeners) safeNotify(listener, message);
  }

  function announceDelete(info: MessageDeletePayload): void {
    hub.dispatch(GatewayEvent.MessageDelete, info);
    for (const listener of deletedListeners) safeNotify(listener, info);
  }

  function announceReaction(kind: 'add' | 'remove', payload: ReactionUpdatePayload, message: Message): void {
    hub.dispatch(
      kind === 'add' ? GatewayEvent.MessageReactionAdd : GatewayEvent.MessageReactionRemove,
      payload,
    );
    const event: ReactionEvent = { message, emoji: payload.emoji, emojiId: payload.emojiId };
    const listeners = kind === 'add' ? reactionAddedListeners : reactionRemovedListeners;
    for (const listener of listeners) safeNotify(listener, event);
  }

  function announceReactionsCleared(payload: ReactionsClearPayload, message: Message): void {
    hub.dispatch(GatewayEvent.MessageReactionsClear, payload);
    const event: ReactionEvent = { message, emoji: payload.emoji, emojiId: payload.emojiId };
    for (const listener of reactionsClearedListeners) safeNotify(listener, event);
  }

  return {
    history(channelId, query, viewerId) {
      requireChannel(channelId);
      const rows = listMessages(sqlite, channelId, {
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
      });
      const ids = rows.map((row) => row.id);
      const byMessage = listAttachmentsForMessages(sqlite, ids);
      const reactions = listReactionsForMessages(sqlite, ids, viewerId);
      return {
        messages: rows.map((row) =>
          toMessage(row, byMessage.get(row.id) ?? [], reactions.get(row.id) ?? []),
        ),
      };
    },

    create(auth, channelId, content, attachmentIds, replyToId) {
      assertNotTimedOut(auth);
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, auth.user.id, content, attachmentIds, replyToId);
      announce(message);
      return message;
    },

    createBridged(channelId, authorId, content, attachmentIds, replyToId, createdAt) {
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, authorId, content, attachmentIds, replyToId, createdAt);
      // Broadcast to clients, but do not announce: this came from Discord and
      // must not be mirrored straight back.
      hub.dispatch(GatewayEvent.MessageCreate, message);
      return message;
    },

    onMessageCreated(listener) {
      createdListeners.add(listener);
    },

    onMessageEdited(listener) {
      editedListeners.add(listener);
    },

    onMessageDeleted(listener) {
      deletedListeners.add(listener);
    },

    onReactionAdded(listener) {
      reactionAddedListeners.add(listener);
    },

    onReactionRemoved(listener) {
      reactionRemovedListeners.add(listener);
    },

    onReactionsCleared(listener) {
      reactionsClearedListeners.add(listener);
    },

    edit(auth, messageId, content) {
      assertNotTimedOut(auth);
      const row = requireMessage(messageId);
      assertCanEdit(auth, row);

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = render(requireMessage(messageId), auth.user.id);
      announceEdit(message);
      return message;
    },

    editBridged(messageId, content) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = render(requireMessage(messageId), row.author_id ?? '');
      hub.dispatch(GatewayEvent.MessageUpdate, message);
      return message;
    },

    remove(auth, messageId) {
      const row = requireMessage(messageId);
      assertCanDelete(auth, row);

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      announceDelete({ id: messageId, channelId: row.channel_id });
    },

    deleteBridged(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      hub.dispatch(GatewayEvent.MessageDelete, { id: messageId, channelId: row.channel_id });
    },

    toggleReaction(auth, messageId, emoji, emojiId) {
      assertNotTimedOut(auth);
      const row = requireMessage(messageId);
      const target = canonicalReaction(emoji, emojiId);

      // Deleting first makes this a toggle: a row that was there is removed.
      const removed = deleteReaction(sqlite, row.id, auth.user.id, target.emoji);
      if (!removed) {
        insertReaction(sqlite, {
          messageId: row.id,
          userId: auth.user.id,
          emoji: target.emoji,
          emojiId: target.emojiId,
          createdAt: new Date().toISOString(),
        });
      }

      const payload: ReactionUpdatePayload = {
        messageId: row.id,
        channelId: row.channel_id,
        emoji: target.emoji,
        emojiId: target.emojiId,
        userId: auth.user.id,
        count: countReaction(sqlite, row.id, target.emoji),
      };
      const message = render(row, auth.user.id);
      announceReaction(removed ? 'remove' : 'add', payload, message);
      return message;
    },

    clearReactions(auth, messageId, emoji, emojiId) {
      const row = requireMessage(messageId);
      if (!hasPermission(auth.permissions, Permission.ManageMessages)) {
        throw new HttpError(403, 'forbidden', 'You need Manage Messages to clear reactions.');
      }

      const target = canonicalReaction(emoji, emojiId);
      deleteReactionsForEmoji(sqlite, row.id, target.emoji);

      const payload: ReactionsClearPayload = {
        messageId: row.id,
        channelId: row.channel_id,
        emoji: target.emoji,
        emojiId: target.emojiId,
      };
      const message = render(row, auth.user.id);
      announceReactionsCleared(payload, message);
      return message;
    },

    addReactionBridged(messageId, userId, emoji, emojiId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      insertReaction(sqlite, {
        messageId: row.id,
        userId,
        emoji,
        emojiId,
        createdAt: new Date().toISOString(),
      });
      hub.dispatch(GatewayEvent.MessageReactionAdd, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId,
        userId,
        count: countReaction(sqlite, row.id, emoji),
      } satisfies ReactionUpdatePayload);
    },

    removeReactionBridged(messageId, userId, emoji) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;
      if (!deleteReaction(sqlite, row.id, userId, emoji)) return;

      hub.dispatch(GatewayEvent.MessageReactionRemove, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId: null,
        userId,
        count: countReaction(sqlite, row.id, emoji),
      } satisfies ReactionUpdatePayload);
    },

    clearReactionsBridged(messageId, emoji, emojiId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      deleteReactionsForEmoji(sqlite, row.id, emoji);
      hub.dispatch(GatewayEvent.MessageReactionsClear, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId,
      } satisfies ReactionsClearPayload);
    },
  };
}
