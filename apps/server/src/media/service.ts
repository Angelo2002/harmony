import type { DatabaseSync } from 'node:sqlite';
import type { MediaItem, MediaListResponse, MediaQuery } from '@harmony/shared';
import type { Config } from '../config.ts';
import { findChannel } from '../db/channels.ts';
import { findAttachment, listMedia, deleteAttachment, listReferencedHashes, toAttachment } from '../db/attachments.ts';
import { findMessage } from '../db/messages.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';

/** What the audit log needs about an image that has just been deleted. */
export interface RemovedMedia {
  filename: string;
  channelName: string | null;
}

export interface MediaService {
  /** A page of stored images, newest first. */
  list(query: MediaQuery): MediaListResponse;
  /** Deletes an attachment and reclaims its bytes when nothing else uses them. */
  remove(attachmentId: string): RemovedMedia;
}

export function createMediaService(sqlite: DatabaseSync, config: Config): MediaService {
  const blobs = createBlobStore(config);

  /** The channel an attachment's message lives in, for the audit log. */
  function channelNameFor(messageId: string | null): string | null {
    if (!messageId) return null;
    const message = findMessage(sqlite, messageId);
    return message ? (findChannel(sqlite, message.channel_id)?.name ?? null) : null;
  }

  return {
    list(query) {
      const media: MediaItem[] = listMedia(sqlite, {
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
      }).map((row) => {
        const uploaderRow = row.uploader_id ? findUserById(sqlite, row.uploader_id) : null;
        return {
          attachment: toAttachment(row),
          uploader: uploaderRow ? presentUser(sqlite, uploaderRow) : null,
          channelId: row.channel_id,
          channelName: row.channel_name,
        };
      });
      return { media };
    },

    remove(attachmentId) {
      const row = findAttachment(sqlite, attachmentId);
      if (!row) throw new HttpError(404, 'attachment_not_found', 'That attachment does not exist.');

      // Read before the row goes, so the audit log can name the file and channel.
      const channelName = channelNameFor(row.message_id);

      deleteAttachment(sqlite, attachmentId);

      // Storage is content-addressed, so the bytes only go once no attachment,
      // emoji or avatar still points at them.
      if (!listReferencedHashes(sqlite).has(row.hash)) blobs.delete(row.hash);

      return { filename: row.filename, channelName };
    },
  };
}
