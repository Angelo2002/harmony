import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';

export interface BlobStore {
  /** Writes the bytes (if not already present) and returns their content hash. */
  save(data: Buffer): string;
  /** Absolute path of the on-disk blob for a content hash. */
  pathFor(hash: string): string;
}

/**
 * Content-addressed blob storage shared by attachments and custom emoji.
 * Identical bytes are only ever written once.
 */
export function createBlobStore(config: Config): BlobStore {
  function pathFor(hash: string): string {
    // Shard by the first byte so a single directory never holds every blob.
    return join(config.uploadDir, hash.slice(0, 2), hash);
  }

  return {
    pathFor,

    save(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      const target = pathFor(hash);
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
      }
      return hash;
    },
  };
}
