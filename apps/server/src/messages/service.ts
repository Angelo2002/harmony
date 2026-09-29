import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  hasPermission,
  type Attachment,
  type Message,
  type MessageHistoryQuery,
  type MessageListResponse,
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
  create(auth: AuthContext, channelId: string, content: string, attachmentIds: string[]): Message;
  /** Inserts a message on behalf of the bridge, skipping permission checks. */
  createBridged(channelId: string, authorId: string, content: string): Message;
  edit(auth: AuthContext, messageId: string, content: string): Message;
  remove(auth: AuthContext, messageId: string): void;
  /** Notified for locally created messages only, never for bridged ones. */
  onMessageCreated(listener: (message: Message) => void): void;
}

export function createMessageService(sqlite: DatabaseSync, hub: GatewayHub): MessageService {
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
    };
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
    insertMessage(sqlite, { id, channelId, authorId, content, createdAt: new Date().toISOString() });
    for (const attachmentId of attachmentIds) attachToMessage(sqlite, attachmentId, id);

    return toMessage(requireMessage(id), attachmentsFor(id));
  }

  const createdListeners = new Set<(message: Message) => void>();

  function announce(message: Message): void {
    hub.dispatch(GatewayEvent.MessageCreate, message);
    for (const listener of createdListeners) {
      try {
        listener(message);
      } catch (error) {
        // A misbehaving listener must not break message creation.
        void error;
      }
    }
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

    create(auth, channelId, content, attachmentIds) {
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, auth.user.id, content, attachmentIds);
      announce(message);
      return message;
    },

    createBridged(channelId, authorId, content) {
      requireChannel(channelId);
      const message = insertWithAttachments(channelId, authorId, content, []);
      // Broadcast to clients, but do not announce: this came from Discord and
      // must not be mirrored straight back.
      hub.dispatch(GatewayEvent.MessageCreate, message);
      return message;
    },

    onMessageCreated(listener) {
      createdListeners.add(listener);
    },

    edit(auth, messageId, content) {
      const row = requireMessage(messageId);
      assertCanModify(auth, row);

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = toMessage(requireMessage(messageId), attachmentsFor(messageId));
      hub.dispatch(GatewayEvent.MessageUpdate, message);
      return message;
    },

    remove(auth, messageId) {
      const row = requireMessage(messageId);
      assertCanModify(auth, row);

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      hub.dispatch(GatewayEvent.MessageDelete, { id: messageId, channelId: row.channel_id });
    },
  };
}
