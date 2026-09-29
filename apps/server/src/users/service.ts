import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  AVATAR_SIZE,
  DEFAULT_MAX_AVATAR_BYTES,
  type ImageContentType,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { findUserById, updateUserProfile, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface UserService {
  updateDisplayName(userId: string, displayName: string | null): UserRow;
  updateAvatar(userId: string, file: { contentType: string; data: Buffer }): Promise<UserRow>;
  clearAvatar(userId: string): UserRow;
  /** Absolute path of an avatar blob. */
  avatarPath(hash: string): string;
}

export function createUserService(sqlite: DatabaseSync, config: Config): UserService {
  const blobs = createBlobStore(config);

  function require(id: string): UserRow {
    const row = findUserById(sqlite, id);
    if (!row) throw new HttpError(404, 'user_not_found', 'That user does not exist.');
    return row;
  }

  return {
    avatarPath: blobs.pathFor,

    updateDisplayName(userId, displayName) {
      const row = require(userId);
      // Empty means "go back to the username".
      const cleaned = displayName && displayName.trim().length > 0 ? displayName.trim() : null;
      updateUserProfile(sqlite, row.id, { displayName: cleaned });
      return require(userId);
    },

    async updateAvatar(userId, file) {
      const row = require(userId);

      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }
      if (file.data.length > DEFAULT_MAX_AVATAR_BYTES) {
        throw new HttpError(
          413,
          'payload_too_large',
          `Profile pictures must be at most ${DEFAULT_MAX_AVATAR_BYTES / (1024 * 1024)} MB.`,
        );
      }

      // Avatars are small and always shown at a fixed size, so normalise them to
      // a square WebP. That keeps storage tiny and avoids storing a content type.
      let normalized: Buffer;
      try {
        normalized = await sharp(file.data)
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      updateUserProfile(sqlite, row.id, { avatarHash: blobs.save(normalized) });
      return require(userId);
    },

    clearAvatar(userId) {
      const row = require(userId);
      updateUserProfile(sqlite, row.id, { avatarHash: null });
      return require(userId);
    },
  };
}
