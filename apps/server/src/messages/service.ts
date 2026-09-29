import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  hasPermission,
  type Message,
  type MessageHistoryQuery,
  type MessageListResponse,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { findChannel } from '../db/channels.ts';
import {
  findMessage,
  insertMessage,
  listMessages,
  softDeleteMessage,
  updateMessageContent,
  type MessageRow,
} from '../db/messages.ts';
import { findUserById, toUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface MessageService {
  history(channelId: string, query: MessageHistoryQuery): MessageListResponse;
  create(auth: AuthContext, channelId: string, content: string): Message;
  edit(auth: AuthContext, messageId: string, content: string): Message;
  remove(auth: AuthContext, messageId: string): void;
}

export function createMessageService(sqlite: DatabaseSync, hub: GatewayHub): MessageService {
  function toMessage(row: MessageRow): Message {
    const authorRow = row.author_id ? findUserById(sqlite, row.author_id) : null;
    return {
      id: row.id,
      channelId: row.channel_id,
      author: authorRow ? toUser(authorRow) : null,
      content: row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      attachments: [],
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

  function assertCanModify(auth: AuthContext, row: MessageRow): void {
    const isAuthor = row.author_id === auth.user.id;
    if (!isAuthor && !hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You can only modify your own messages.');
    }
  }

  return {
    history(channelId, query) {
      requireChannel(channelId);
      const messages = listMessages(sqlite, channelId, { limit: query.limit, before: query.before }).map(toMessage);
      return { messages };
    },

    create(auth, channelId, content) {
      requireChannel(channelId);
      const id = randomUUID();
      insertMessage(sqlite, {
        id,
        channelId,
        authorId: auth.user.id,
        content,
        createdAt: new Date().toISOString(),
      });

      const message = toMessage(requireMessage(id));
      hub.dispatch(GatewayEvent.MessageCreate, message);
      return message;
    },

    edit(auth, messageId, content) {
      const row = requireMessage(messageId);
      assertCanModify(auth, row);

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      const message = toMessage(requireMessage(messageId));
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
