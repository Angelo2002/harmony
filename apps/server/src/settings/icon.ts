import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MAX_ICON_BYTES,
  ICON_SIZE,
  type ImageContentType,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';
import type { SettingsService } from './service.ts';

export interface IconService {
  /** Content hash of the uploaded icon, or null when the default is in use. */
  hash(): string | null;
  /** Absolute path of the stored icon blob. */
  pathFor(hash: string): string;
  /** Normalises and stores an uploaded icon, returning its content hash. */
  update(file: { contentType: string; data: Buffer }): Promise<string>;
  /** Drops the uploaded icon, so clients fall back to the built-in default. */
  clear(): void;
}

/**
 * The instance icon shown in the browser tab and beside the server name. It is
 * normalised to a square PNG, which every browser accepts as a favicon, and the
 * default is shipped with the web client, so nothing is stored until an admin
 * uploads their own.
 */
export function createIconService(config: Config, settings: SettingsService): IconService {
  const blobs = createBlobStore(config);

  return {
    hash: () => settings.getIconHash(),
    pathFor: blobs.pathFor,

    async update(file) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }
      if (file.data.length > DEFAULT_MAX_ICON_BYTES) {
        throw new HttpError(
          413,
          'payload_too_large',
          `Server icons must be at most ${DEFAULT_MAX_ICON_BYTES / (1024 * 1024)} MB.`,
        );
      }

      let normalized: Buffer;
      try {
        normalized = await sharp(file.data)
          .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer();
      } catch {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      const hash = blobs.save(normalized);
      settings.setIconHash(hash);
      return hash;
    },

    clear() {
      settings.setIconHash(null);
    },
  };
}
