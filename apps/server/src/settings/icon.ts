import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_ICON_PADDING,
  DEFAULT_MAX_ICON_BYTES,
  ICON_SIZE,
  MAX_ICON_PADDING,
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
  /** Normalizes and stores an uploaded icon, returning its content hash. */
  update(file: { contentType: string; data: Buffer }): Promise<string>;
  /** Drops the uploaded icon, so clients fall back to the built-in default. */
  clear(): void;
  /** A square PNG of the instance icon at `size`, or null when there is none. */
  render(size: number): Promise<Buffer | null>;
  /**
   * The variant an installed app icon needs: the one the operating system will
   * crop to a shape of its own. See `maskableFrom` for how it is laid out.
   */
  renderMaskable(size: number): Promise<Buffer | null>;
  /**
   * A string that changes whenever anything the rendered icon depends on changes.
   * Callers put it in the URL, since the responses are cached immutably.
   */
  version(): string;
}

/** A color as channels, which is how sharp takes a background. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` as channels. The settings layer only ever stores that form. */
function hexToRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** Everything worth knowing about the icon artwork. */
interface Artwork {
  /** The average color of the pixels that are actually there, or null if none are. */
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
 * Measures the artwork: what color it is, and whether it is a picture or a logo.
 *
 * Transparent pixels are skipped when averaging. A logo drawn on nothing would
 * otherwise average out close to black, and sharp's own dominant color has
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
 * The variant an operating system crops to a shape of its own, so anything that
 * would be cut has to be kept away from the edges.
 *
 * How much room to leave is the instance's to decide, because it depends on the
 * artwork: a picture that fills its own frame wants none, and a logo drawn on
 * transparency wants enough that the crop takes the tile instead of the drawing.
 * Left to itself, that choice is made from the image. Whatever is left over is
 * filled with a color the instance chooses, or the artwork's own by default. The
 * padding is a share of the tile, so 10 means the artwork is drawn at 80%.
 *
 * The artwork is composited onto that fill even at zero padding, which is what
 * keeps the result opaque: a transparent icon is left for the platform to back,
 * and iOS backs those with black.
 */
async function maskableFrom(
  source: string,
  size: number,
  padding: number,
  background: Rgb,
): Promise<Buffer> {
  const inner = Math.max(1, Math.round(size * (1 - padding / 100)));
  const scaled = await sharp(source).resize(inner, inner, { fit: 'cover', position: 'center' }).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: scaled, top: pad, left: pad }])
    .png()
    .toBuffer();
}

/**
 * The instance icon shown in the browser tab and beside the server name, and the
 * source for the sizes an installed app icon needs. It is normalized to a square
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
    const chosen = settings.get().icon;

    // Left to the instance, the padding follows the artwork: a picture that fills
    // its own frame gets none, a logo drawn on transparency gets the default.
    const padding = chosen.padding ?? (art.opaque ? 0 : DEFAULT_ICON_PADDING);

    // The background is only ever seen where the padding leaves a gap, and the
    // artwork's own color is the one that reads as part of the icon rather than
    // as a frame around it. Artwork with nothing opaque in it has no color of
    // its own, so that falls back to the app's background.
    const theme = deriveTheme(settings.get().theme);
    const background = chosen.background
      ? hexToRgb(chosen.background)
      : (art.color ?? hexToRgb(theme.bg));

    const key = `${source}|${size}|${maskable ? 'maskable' : 'any'}|${padding}|${background.r},${background.g},${background.b}`;
    const cached = rendered.get(key);
    if (cached) return cached;

    // Always opaque. A transparent icon is left to the platform to back, and iOS
    // backs those with black: the same dark frame by another route.
    const buffer = maskable
      ? await maskableFrom(source, size, padding, background)
      : await sharp(source)
          .resize(size, size, { fit: 'cover', position: 'center' })
          .flatten({ background })
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

    version() {
      const icon = settings.get().icon;
      // Everything the rendered icon depends on, so a change to any of it is a
      // new URL and the long cache cannot serve the old one.
      return [settings.getIconHash() ?? 'default', icon.padding ?? 'auto', icon.background ?? 'auto'].join('-');
    },

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
          .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover', position: 'center' })
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
