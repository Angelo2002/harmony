import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';

export interface BlobStore {
  /** Writes the bytes (if not already present) and returns their content hash. */
  save(data: Buffer): string;
  /** Absolute path of the on-disk blob for a content hash. */
  pathFor(hash: string): string;
  /** Removes a blob, returning the number of bytes freed (0 if absent). */
  delete(hash: string): number;
  /** Every content hash currently on disk. */
  listHashes(): string[];
  /** Total size of all stored blobs, in bytes. */
  totalBytes(): number;
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

  function forEachShard(visit: (dir: string) => void): void {
    if (!existsSync(config.uploadDir)) return;
    for (const entry of readdirSync(config.uploadDir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(config.uploadDir, entry.name));
    }
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

    delete(hash) {
      const target = pathFor(hash);
      try {
        const size = statSync(target).size;
        rmSync(target);
        return size;
      } catch {
        return 0;
      }
    },

    listHashes() {
      const hashes: string[] = [];
      forEachShard((dir) => {
        for (const file of readdirSync(dir)) hashes.push(file);
      });
      return hashes;
    },

    totalBytes() {
      let total = 0;
      forEachShard((dir) => {
        for (const file of readdirSync(dir)) {
          try {
            total += statSync(join(dir, file)).size;
          } catch {
            // The file vanished mid-walk; nothing to count.
          }
        }
      });
      return total;
    },
  };
}
