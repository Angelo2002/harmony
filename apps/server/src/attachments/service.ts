import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { ALLOWED_IMAGE_TYPES, type Attachment, type ImageContentType } from '@harmony/shared';
import type { Config } from '../config.ts';
import type { AuthContext } from '../auth/service.ts';
import { findAttachment, insertAttachment, toAttachment, type AttachmentRow } from '../db/attachments.ts';
import { HttpError } from '../http/errors.ts';
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

export function createAttachmentService(sqlite: DatabaseSync, config: Config): AttachmentService {
  const blobs = createBlobStore(config);

  return {
    filePathFor: blobs.pathFor,

    find(id) {
      return findAttachment(sqlite, id);
    },

    async upload(auth, file) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }
      if (file.data.length > config.maxUploadBytes) {
        throw new HttpError(
          413,
          'payload_too_large',
          `Images must be at most ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB.`,
        );
      }

      // Reading metadata both validates that the data really is an image and
      // gives us the dimensions needed to render without layout shift.
      let metadata: Metadata;
      try {
        metadata = await sharp(file.data).metadata();
      } catch {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      const hash = blobs.save(file.data);

      const id = randomUUID();
      insertAttachment(sqlite, {
        id,
        uploaderId: auth.user.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.data.length,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        hash,
        createdAt: new Date().toISOString(),
      });

      const row = findAttachment(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to store the upload.');
      return toAttachment(row);
    },
  };
}
