import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  type Attachment,
  type ImageContentType,
  type VideoContentType,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import type { AuthContext } from '../auth/service.ts';
import { assertNotTimedOut } from '../auth/guards.ts';
import { findAttachment, insertAttachment, toAttachment, type AttachmentRow } from '../db/attachments.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface UploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface AttachmentService {
  upload(auth: AuthContext, file: UploadInput): Promise<Attachment>;
  find(id: string): AttachmentRow | null;
  /** Absolute path of the on-disk blob for a content hash. */
  filePathFor(hash: string): string;
}

/**
 * An MP4 starts with a size word followed by the `ftyp` box. Videos are not
 * decoded, so this is the cheap sanity check that keeps arbitrary bytes from
 * being stored under a video content type.
 */
function looksLikeMp4(data: Buffer): boolean {
  return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function createAttachmentService(
  sqlite: DatabaseSync,
  config: Config,
  settings: SettingsService,
): AttachmentService {
  const blobs = createBlobStore(config);

  return {
    filePathFor: blobs.pathFor,

    find(id) {
      return findAttachment(sqlite, id);
    },

    async upload(auth, file) {
      assertNotTimedOut(auth);

      const isImage = ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType);
      const isVideo = ALLOWED_VIDEO_TYPES.includes(file.contentType as VideoContentType);
      if (!isImage && !isVideo) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported file type "${file.contentType}". Allowed: ${[...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].join(', ')}.`,
        );
      }

      const limits = settings.get();
      const limit = isVideo ? limits.maxVideoBytes : limits.maxImageBytes;
      if (file.data.length > limit) {
        throw new HttpError(
          413,
          'payload_too_large',
          `${isVideo ? 'Videos' : 'Images'} must be at most ${megabytes(limit)} MB.`,
        );
      }

      // Images are re-validated by sharp, which also gives us their dimensions so
      // they render without a layout shift. Videos carry no dimensions.
      let width: number | null = null;
      let height: number | null = null;
      if (isImage) {
        let metadata: Metadata;
        try {
          metadata = await sharp(file.data).metadata();
        } catch {
          throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
        }
        width = metadata.width ?? null;
        height = metadata.height ?? null;
      } else if (!looksLikeMp4(file.data)) {
        throw new HttpError(415, 'invalid_video', 'That file is not a readable MP4 video.');
      }

      const hash = blobs.save(file.data);

      const id = randomUUID();
      insertAttachment(sqlite, {
        id,
        uploaderId: auth.user.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.data.length,
        width,
        height,
        hash,
        createdAt: new Date().toISOString(),
      });

      const row = findAttachment(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to store the upload.');
      return toAttachment(row);
    },
  };
}
