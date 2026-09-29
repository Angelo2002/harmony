/** Product-wide constants shared by the server, web client and bridge bot. */

export const HARMONY_NAME = 'Harmony';

/** Version prefix for all REST routes, e.g. `/api/v1`. */
export const API_VERSION = 'v1';

/** Bumped whenever the gateway event protocol changes incompatibly. */
export const GATEWAY_VERSION = 1;

/** Default heartbeat cadence for the gateway, in milliseconds. */
export const GATEWAY_HEARTBEAT_MS = 45_000;

/** Limits enforced by the API and mirrored by the UI. */
export const LIMITS = {
  username: { min: 2, max: 32 },
  password: { min: 8, max: 200 },
  channelName: { min: 1, max: 64 },
  displayName: { max: 32 },
  messageLength: 4_000,
  attachmentsPerMessage: 10,
} as const;

/** Image formats accepted by the attachment upload endpoint. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageContentType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Default maximum size of a single upload, in bytes (10 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Maximum size of a custom emoji image, in bytes (256 KiB). */
export const DEFAULT_MAX_EMOJI_BYTES = 256 * 1024;

/** Maximum size of an uploaded profile picture, in bytes (2 MiB). */
export const DEFAULT_MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Profile pictures are normalised to this square size. */
export const AVATAR_SIZE = 256;
