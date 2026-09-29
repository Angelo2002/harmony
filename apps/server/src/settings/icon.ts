import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MAX_ICON_BYTES,
  ICON_SIZE,
  deriveTheme,
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
  /** A square PNG of the instance icon at `size`, or null when there is none. */
  render(size: number): Promise<Buffer | null>;
  /** The icon padded into Android's maskable safe zone, on the themed background. */
  renderMaskable(size: number): Promise<Buffer | null>;
}

/**
 * Android crops a maskable icon to whatever shape the launcher uses, so the
 * artwork is drawn at 80% and centred on a themed square that takes the clipping.
 */
async function maskableFrom(source: string, size: number, background: string): Promise<Buffer> {
  const inner = Math.max(1, Math.round(size * 0.8));
  const art = await sharp(source).resize(inner, inner, { fit: 'cover', position: 'centre' }).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toBuffer();
}

/**
 * The instance icon shown in the browser tab and beside the server name, and the
 * source for the sizes an installed app icon needs. It is normalised to a square
 * PNG, and the default is shipped with the web client, so nothing is stored until
 * an admin uploads their own.
 */
export function createIconService(config: Config, settings: SettingsService): IconService {
  const blobs = createBlobStore(config);
  // A handful of small buffers, keyed by source and size, kept so the manifest's
  // icon requests do not re-encode the image every time.
  const rendered = new Map<string, Buffer>();

  /**
   * Where the icon comes from: the admin's upload, or the default shipped with
   * the web client. Null when neither exists, which means there is no client
   * build to install as an app anyway.
   */
  function sourcePath(): string | null {
    const hash = settings.getIconHash();
    if (hash) {
      const path = blobs.pathFor(hash);
      if (existsSync(path)) return path;
    }
    const fallback = join(config.webDir, 'icon.png');
    return existsSync(fallback) ? fallback : null;
  }

  async function render(size: number, maskable: boolean): Promise<Buffer | null> {
    const source = sourcePath();
    if (!source) return null;

    // The maskable padding follows the theme, so the tile matches the app.
    const background = maskable ? deriveTheme(settings.get().theme).bg : '';
    const key = `${source}|${size}|${background}`;
    const cached = rendered.get(key);
    if (cached) return cached;

    const buffer = maskable
      ? await maskableFrom(source, size, background)
      : await sharp(source).resize(size, size, { fit: 'cover', position: 'centre' }).png().toBuffer();

    rendered.set(key, buffer);
    return buffer;
  }

  return {
    hash: () => settings.getIconHash(),
    pathFor: blobs.pathFor,

    render: (size) => render(size, false),
    renderMaskable: (size) => render(size, true),

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
