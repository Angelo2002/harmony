import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { findSticker, type StickerRow } from '../db/stickers.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface StickerService {
  find(id: string): StickerRow | null;
  /** Absolute path of the on-disk image for a sticker row. */
  pathFor(hash: string): string;
}

/** Read access to learned stickers, so their images can be served by id. */
export function createStickerService(sqlite: DatabaseSync, config: Config): StickerService {
  const blobs = createBlobStore(config);

  return {
    find(id) {
      return findSticker(sqlite, id);
    },

    pathFor(hash) {
      return blobs.pathFor(hash);
    },
  };
}
