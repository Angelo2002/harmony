import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  AVATAR_SIZE,
  DEFAULT_MAX_AVATAR_BYTES,
  type ImageContentType,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import {
  findUserById,
  findUserByUsername,
  updateUserAccount,
  updateUserProfile,
  type UserRow,
} from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface UserService {
  updateProfile(userId: string, patch: { displayName?: string | null; showTyping?: boolean }): UserRow;
  /** Changes a member's own password after checking the one they already have. */
  changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void>;
  /**
   * An administrator editing another account. `password` sets a new one without
   * ever reading the old; callers must end the target's sessions afterwards.
   */
  adminUpdate(
    userId: string,
    patch: { username?: string; displayName?: string | null; password?: string },
  ): Promise<UserRow>;
  updateAvatar(userId: string, file: { contentType: string; data: Buffer }): Promise<UserRow>;
  /**
   * Stores a normalised avatar from raw bytes. Used by the bridge, where the
   * bytes come from Discord with no declared content type. Returns null when
   * the data is unusable.
   */
  setAvatarFromData(userId: string, data: Buffer): Promise<UserRow | null>;
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

  /**
   * Avatars are small and always shown at a fixed size, so they are normalised
   * to a square WebP. That keeps storage tiny and means we never have to store
   * a content type alongside them.
   */
  async function normalizeAvatar(data: Buffer): Promise<Buffer | null> {
    if (data.length > DEFAULT_MAX_AVATAR_BYTES) return null;
    try {
      return await sharp(data)
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  return {
    avatarPath: blobs.pathFor,

    updateProfile(userId, patch) {
      const row = require(userId);
      const clean: { displayName?: string | null; showTyping?: boolean } = {};
      if (patch.displayName !== undefined) {
        // Empty means "go back to the username".
        clean.displayName =
          patch.displayName && patch.displayName.trim().length > 0 ? patch.displayName.trim() : null;
      }
      if (patch.showTyping !== undefined) clean.showTyping = patch.showTyping;
      updateUserProfile(sqlite, row.id, clean);
      return require(userId);
    },

    async changePassword(userId, currentPassword, nextPassword) {
      const row = require(userId);
      const ok = await verifyPassword(currentPassword, row.password_hash);
      if (!ok) throw new HttpError(403, 'wrong_password', 'Your current password is not correct.');
      updateUserAccount(sqlite, row.id, { passwordHash: await hashPassword(nextPassword) });
    },

    async adminUpdate(userId, patch) {
      const row = require(userId);

      if (patch.username !== undefined && patch.username !== row.username) {
        const taken = findUserByUsername(sqlite, patch.username);
        if (taken && taken.id !== row.id) {
          throw new HttpError(409, 'username_taken', 'That username is already taken.');
        }
      }

      const account: { username?: string; passwordHash?: string } = {};
      if (patch.username !== undefined) account.username = patch.username;
      if (patch.password !== undefined) account.passwordHash = await hashPassword(patch.password);
      updateUserAccount(sqlite, row.id, account);

      if (patch.displayName !== undefined) {
        const trimmed = patch.displayName?.trim() ?? '';
        updateUserProfile(sqlite, row.id, { displayName: trimmed.length > 0 ? trimmed : null });
      }

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

      const normalized = await normalizeAvatar(file.data);
      if (!normalized) {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      updateUserProfile(sqlite, row.id, { avatarHash: blobs.save(normalized) });
      return require(userId);
    },

    async setAvatarFromData(userId, data) {
      const row = findUserById(sqlite, userId);
      if (!row) return null;

      const normalized = await normalizeAvatar(data);
      if (!normalized) return null;

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
