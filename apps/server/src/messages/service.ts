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
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { attachToMessage, findAttachment, listAttachmentsForMessages } from '../db/attachments.ts';
import { findChannel } from '../db/channels.ts';
import {
  findMessage,
  insertMessage,
  listMessages,
  softDeleteMessage,
  updateMessageContent,
  type MessageRow,
} from '../db/messages.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface MessageService {
  history(channelId: string, query: MessageHistoryQuery): MessageListResponse;
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
  ): Message;
  edit(auth: AuthContext, messageId: string, content: string): Message;
  /** Applies a bridged edit, without notifying the outbound listeners. */
  editBridged(messageId: string, content: string): Message | null;
  remove(auth: AuthContext, messageId: string): void;
  /** Applies a bridged deletion, without notifying the outbound listeners. */
  deleteBridged(messageId: string): void;
  /** Notified for locally created messages only, never for bridged ones. */
  onMessageCreated(listener: (message: Message) => void): void;
  onMessageEdited(listener: (message: Message) => void): void;
  onMessageDeleted(listener: (info: MessageDeletePayload) => void): void;
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

  function toMessage(row: MessageRow, attachments: Attachment[]): Message {
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
    };
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

  function assertCanModify(auth: AuthContext, row: MessageRow): void {
    const isAuthor = row.author_id === auth.user.id;
    if (!isAuthor && !hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You can only modify your own messages.');
    }
  }

  function insertWithAttachments(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
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
      createdAt: new Date().toISOString(),
      replyToId: resolveReplyTo(channelId, replyToId),
    });
    for (const attachmentId of attachmentIds) attachToMessage(sqlite, attachmentId, id);

    return toMessage(requireMessage(id), attachmentsFor(id));
  }

  const createdListeners = new Set<(message: Message) => void>();
  const editedListeners = new Set<(message: Message) => void>();
  const deletedListeners = new Set<(info: MessageDeletePayload) => void>();

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

  return {
    history(channelId, query) {
      requireChannel(channelId);
      const rows = listMessages(sqlite, channelId, { limit: query.limit, before: query.before });
      const byMessage = listAttachmentsForMessages(
        sqlite,
        rows.map((row) => row.id),
      );
      return { messages: rows.map((row) => toMessage(row, byMessage.get(row.id) ?? [])) };
    },

    create(auth, channelId, content, attachmentIds, replyToId) {
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, auth.user.id, content, attachmentIds, replyToId);
      announce(message);
      return message;
    },

    createBridged(channelId, authorId, content, attachmentIds, replyToId) {
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, authorId, content, attachmentIds, replyToId);
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

    edit(auth, messageId, content) {
      const row = requireMessage(messageId);
      assertCanModify(auth, row);

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = toMessage(requireMessage(messageId), attachmentsFor(messageId));
      announceEdit(message);
      return message;
    },

    editBridged(messageId, content) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = toMessage(requireMessage(messageId), attachmentsFor(messageId));
      hub.dispatch(GatewayEvent.MessageUpdate, message);
      return message;
    },

    remove(auth, messageId) {
      const row = requireMessage(messageId);
      assertCanModify(auth, row);

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      announceDelete({ id: messageId, channelId: row.channel_id });
    },

    deleteBridged(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      hub.dispatch(GatewayEvent.MessageDelete, { id: messageId, channelId: row.channel_id });
    },
  };
}
