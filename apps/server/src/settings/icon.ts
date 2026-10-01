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

/** A colour as channels, which is how sharp takes a background. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Everything worth knowing about the icon artwork. */
interface Artwork {
  /** The average colour of the pixels that are actually there, or null if none are. */
  color: Rgb | null;
  /**
   * True when there is not one transparent pixel: a picture that fills its own
   * frame, rather than a logo drawn on nothing.
   */
  opaque: boolean;
}

/** Alpha at or below this is a pixel that is not really there. */
const TRANSPARENT_CUTOFF = 8;

/**
 * Measures the artwork: what colour it is, and whether it is a picture or a logo.
 *
 * Transparent pixels are skipped when averaging. A logo drawn on nothing would
 * otherwise average out close to black, and sharp's own dominant colour has
 * exactly that problem, which is the dark frame this exists to avoid.
 */
async function measureArtwork(source: string): Promise<Artwork> {
  // Small: only an average is wanted, and the answer is cached by the caller.
  const { data, info } = await sharp(source)
    .resize(48, 48, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  let seen = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    total += 1;
    if ((data[i + 3] ?? 0) <= TRANSPARENT_CUTOFF) continue;
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    seen += 1;
  }

  return {
    color: seen === 0 ? null : { r: r / seen, g: g / seen, b: b / seen },
    opaque: total > 0 && seen === total,
  };
}

/**
 * The variant Android crops to whatever shape its launcher uses, so anything that
 * would be cut has to be kept away from the edges.
 *
 * A picture that already fills its frame is passed through at full size, because
 * that is how it was drawn: padding it would only shrink it and ring it with a
 * border nobody asked for. A logo drawn on transparency is the case the padding
 * exists for, and it is drawn at 80% on a tile of its own colour, so the cropping
 * that is coming takes the tile rather than the artwork.
 */
async function maskableFrom(source: string, size: number, art: Artwork, tile: Rgb): Promise<Buffer> {
  if (art.opaque) {
    return sharp(source).resize(size, size, { fit: 'cover', position: 'centre' }).png().toBuffer();
  }

  const inner = Math.max(1, Math.round(size * 0.8));
  const scaled = await sharp(source).resize(inner, inner, { fit: 'cover', position: 'centre' }).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 3, background: tile } })
    .composite([{ input: scaled, top: pad, left: pad }])
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
  // Measuring walks the pixels, and the answer only depends on the source.
  const measured = new Map<string, Promise<Artwork>>();

  function artworkOf(source: string): Promise<Artwork> {
    let pending = measured.get(source);
    if (!pending) {
      pending = measureArtwork(source);
      measured.set(source, pending);
    }
    return pending;
  }

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

    const art = await artworkOf(source);

    // The tile only matters for artwork that leaves gaps to fill, but it is
    // always worked out, since it is also what tells the two apart in the cache
    // key below. Artwork with nothing opaque in it has no colour of its own, so
    // it falls back to the app's background.
    const theme = deriveTheme(settings.get().theme);
    const tile = art.color ?? {
      r: Number.parseInt(theme.bg.slice(1, 3), 16),
      g: Number.parseInt(theme.bg.slice(3, 5), 16),
      b: Number.parseInt(theme.bg.slice(5, 7), 16),
    };

    const key = `${source}|${size}|${maskable ? 'maskable' : 'any'}|${tile.r},${tile.g},${tile.b}`;
    const cached = rendered.get(key);
    if (cached) return cached;

    // Always opaque. A transparent icon is left to the platform to back, and iOS
    // backs those with black: the same dark frame by another route.
    const buffer = maskable
      ? await maskableFrom(source, size, art, tile)
      : await sharp(source)
          .resize(size, size, { fit: 'cover', position: 'centre' })
          .flatten({ background: tile })
          .png()
          .toBuffer();

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
