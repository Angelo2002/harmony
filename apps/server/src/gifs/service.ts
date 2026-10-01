import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ALLOWED_IMAGE_TYPES, type Attachment, type GifFavorite, type GifItem, type ImageContentType } from '@harmony/shared';
import { canAccessChannel, channelAccessFor, visibleChannels } from '../access/service.ts';
import type { AuthContext } from '../auth/service.ts';
import type { Config } from '../config.ts';
import {
  findAttachment,
  insertAttachment,
  listRecentImageAttachments,
  toAttachment,
  type AttachmentRow,
} from '../db/attachments.ts';
import {
  deleteGifFavorite,
  favoriteIdsByHash,
  findGifFavorite,
  listGifFavoritesForUser,
  touchGifFavorite,
  toGifFavorite,
  upsertGifFavorite,
} from '../db/gif_favorites.ts';
import { findMessage } from '../db/messages.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore, type BlobStore } from '../storage/blobs.ts';

export interface GifService {
  /** The gifs this member has kept, most recently used first. */
  listFavorites(auth: AuthContext): GifFavorite[];
  /** Keeps a gif this instance already holds. The bytes are already here. */
  addFavorite(auth: AuthContext, attachmentId: string): GifFavorite;
  removeFavorite(auth: AuthContext, favoriteId: string): void;
  /**
   * Takes a gif into the message being written: a copy is made as an unattached
   * attachment owned by the caller, which the message then claims exactly as it
   * would an upload. No bytes move, since the gif is already stored.
   */
  pick(auth: AuthContext, ref: { attachmentId?: string; favoriteId?: string }): Attachment;
  /** Absolute path of a kept gif's bytes, or null when they are gone. */
  filePathFor(favorite: { hash: string }): string | null;
  /**
   * Gifs this instance already holds, for the picker's local tab: one per picture,
   * newest first, and only from channels the member may see.
   */
  listLocal(auth: AuthContext, query: { q?: string; limit: number }): GifItem[];
}

/** How many candidate rows to look at to fill a page once duplicates are dropped. */
const LOCAL_SCAN_FACTOR = 4;
const LOCAL_SCAN_LIMIT = 400;

/** A gif is an image, and only the types this instance stores are keepable. */
function isGifImage(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(contentType as ImageContentType);
}

export function createGifService(sqlite: DatabaseSync, config: Config): GifService {
  const blobs: BlobStore = createBlobStore(config);

  function missing(): never {
    // A gif in a channel this member cannot see is reported as absent, so a locked
    // channel leaks nothing by way of its gifs either.
    throw new HttpError(404, 'gif_not_found', 'That gif does not exist.');
  }

  /** Whether the member may see the attachment this gif came from, or own it. */
  function assertMayUseAttachment(auth: AuthContext, attachment: AttachmentRow): void {
    if (attachment.message_id === null) {
      if (attachment.uploader_id !== auth.user.id) missing();
      return;
    }
    const message = findMessage(sqlite, attachment.message_id);
    if (!message) missing();
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), message.channel_id)) missing();
  }

  function requireStoredBytes(hash: string): void {
    if (!existsSync(blobs.pathFor(hash))) {
      throw new HttpError(404, 'gif_missing', 'That gif is missing from storage.');
    }
  }

  return {
    listFavorites(auth) {
      return listGifFavoritesForUser(sqlite, auth.user.id).map(toGifFavorite);
    },

    addFavorite(auth, attachmentId) {
      const attachment = findAttachment(sqlite, attachmentId);
      if (!attachment) missing();
      assertMayUseAttachment(auth, attachment);
      if (!isGifImage(attachment.content_type)) {
        throw new HttpError(400, 'not_a_gif', 'Only images can be kept.');
      }
      requireStoredBytes(attachment.hash);

      return toGifFavorite(
        upsertGifFavorite(sqlite, {
          userId: auth.user.id,
          hash: attachment.hash,
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          // Kept only as a note of where it came from; the bytes are what matter.
          sourceUrl: attachment.source_url,
        }),
      );
    },

    removeFavorite(auth, favoriteId) {
      const favorite = findGifFavorite(sqlite, favoriteId);
      if (!favorite || favorite.user_id !== auth.user.id) missing();
      deleteGifFavorite(sqlite, favorite.id);
    },

    pick(auth, ref) {
      let source: {
        hash: string;
        filename: string;
        contentType: string;
        size: number;
        width: number | null;
        height: number | null;
      };

      if (ref.favoriteId !== undefined) {
        const favorite = findGifFavorite(sqlite, ref.favoriteId);
        if (!favorite || favorite.user_id !== auth.user.id) missing();
        requireStoredBytes(favorite.hash);
        // Picking a kept gif counts as using it, which its retention counts from.
        touchGifFavorite(sqlite, auth.user.id, favorite.hash);
        source = {
          hash: favorite.hash,
          filename: favorite.filename,
          contentType: favorite.content_type,
          size: favorite.size,
          width: favorite.width,
          height: favorite.height,
        };
      } else if (ref.attachmentId !== undefined) {
        const attachment = findAttachment(sqlite, ref.attachmentId);
        if (!attachment) missing();
        assertMayUseAttachment(auth, attachment);
        if (!isGifImage(attachment.content_type)) {
          throw new HttpError(400, 'not_a_gif', 'Only images can be sent from the picker.');
        }
        requireStoredBytes(attachment.hash);
        source = {
          hash: attachment.hash,
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
        };
      } else {
        throw new HttpError(400, 'gif_reference_required', 'Name the gif to send.');
      }

      // The bytes are already stored, so this is a row and nothing more. The source
      // link is deliberately left off: a picked gif belongs to its message the way
      // an upload does, and is not undone when the text around it changes.
      const id = randomUUID();
      insertAttachment(sqlite, {
        id,
        uploaderId: auth.user.id,
        filename: source.filename,
        contentType: source.contentType,
        size: source.size,
        width: source.width,
        height: source.height,
        hash: source.hash,
        createdAt: new Date().toISOString(),
      });

      const row = findAttachment(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to send that gif.');
      return toAttachment(row);
    },

    filePathFor(favorite) {
      const path = blobs.pathFor(favorite.hash);
      return existsSync(path) ? path : null;
    },

    listLocal(auth, query) {
      const access = channelAccessFor(sqlite, auth.user.id);
      // Administrators see everything; everybody else only their own channels, so a
      // gif in a locked channel never turns up in somebody's picker.
      const channelIds = access.bypass ? null : visibleChannels(sqlite, access).map((channel) => channel.id);

      const rows = listRecentImageAttachments(sqlite, {
        channelIds,
        q: query.q && query.q.length > 0 ? query.q : null,
        // The same picture is sent over and over, so a page's worth of rows holds
        // far fewer distinct gifs; read ahead before dropping the duplicates.
        limit: Math.min(query.limit * LOCAL_SCAN_FACTOR, LOCAL_SCAN_LIMIT),
      });

      const saved = favoriteIdsByHash(sqlite, auth.user.id);
      const seen = new Set<string>();
      const gifs: GifItem[] = [];

      for (const row of rows) {
        if (seen.has(row.hash)) continue;
        seen.add(row.hash);
        gifs.push({
          id: row.id,
          hash: row.hash,
          filename: row.filename,
          contentType: row.content_type,
          size: row.size,
          width: row.width,
          height: row.height,
          sourceUrl: row.source_url,
          createdAt: row.created_at,
          favoriteId: saved.get(row.hash) ?? null,
        });
        if (gifs.length >= query.limit) break;
      }
      return gifs;
    },
  };
}
