import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { ALLOWED_IMAGE_TYPES, DEFAULT_MAX_EMOJI_BYTES, type Emoji, type ImageContentType } from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { Config } from '../config.ts';
import {
  deleteEmoji,
  findEmoji,
  findEmojiByName,
  insertEmoji,
  listEmojis,
  toEmoji,
  type EmojiRow,
} from '../db/emojis.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface EmojiUpload {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface EmojiService {
  list(): Emoji[];
  find(id: string): EmojiRow | null;
  /** Absolute path of the on-disk image for an emoji row. */
  pathFor(hash: string): string;
  create(auth: AuthContext, name: string, file: EmojiUpload): Promise<Emoji>;
  remove(id: string): void;
}

export function createEmojiService(sqlite: DatabaseSync, config: Config): EmojiService {
  const blobs = createBlobStore(config);

  return {
    list() {
      return listEmojis(sqlite).map(toEmoji);
    },

    find(id) {
      return findEmoji(sqlite, id);
    },

    pathFor(hash) {
      return blobs.pathFor(hash);
    },

    async create(auth, name, file) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }

      const limit = DEFAULT_MAX_EMOJI_BYTES;
      if (file.data.length > limit) {
        throw new HttpError(413, 'payload_too_large', `Emoji images must be at most ${limit / 1024} KB.`);
      }

      if (findEmojiByName(sqlite, name)) {
        throw new HttpError(409, 'emoji_exists', `An emoji named "${name}" already exists.`);
      }

      let metadata: Metadata;
      try {
        metadata = await sharp(file.data).metadata();
      } catch {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      const id = randomUUID();
      insertEmoji(sqlite, {
        id,
        name,
        hash: blobs.save(file.data),
        contentType: file.contentType,
        animated: (metadata.pages ?? 1) > 1,
        createdBy: auth.user.id,
        createdAt: new Date().toISOString(),
      });

      const row = findEmoji(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to store the emoji.');
      return toEmoji(row);
    },

    remove(id) {
      deleteEmoji(sqlite, id);
    },
  };
}
