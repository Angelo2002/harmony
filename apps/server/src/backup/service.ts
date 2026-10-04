import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import { backup, type DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import type { ServerLogService } from '../log/service.ts';
import { tarStream, type TarEntry } from './tar.ts';

/** The name the database has inside the archive, and in the data directory. */
export const BACKUP_DB_NAME = 'harmony.db';

/** Temporary snapshots sit in the data directory under this prefix. */
const SNAPSHOT_PREFIX = '.backup-';

export interface BackupDownload {
  filename: string;
  /** The gzipped tar, produced as it is read. */
  stream: Readable;
  /**
   * Deletes the snapshot and frees the one-at-a-time slot. Idempotent, and it
   * also runs automatically as the stream ends or is torn down; a caller uses it
   * as a backstop for the case where the stream is never consumed at all.
   */
  release(): void;
}

/**
 * Whole-instance backups: a consistent copy of the database plus every
 * uploaded file, as one `.tar.gz` laid out exactly like the data directory, so
 * restoring is extracting it in place.
 */
export interface BackupService {
  /**
   * Takes the database snapshot, then returns the archive as a stream. The
   * snapshot is deleted once the stream ends, fails or is abandoned.
   */
  open(serverName: string): Promise<BackupDownload>;
}

/** A name safe for a file name and a `Content-Disposition` header: ASCII, no spaces. */
export function fileSlug(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/** Today's date as `YYYY-MM-DD`, in UTC so the name does not depend on the host's zone. */
export function fileDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function createBackupService(sqlite: DatabaseSync, config: Config, serverLog?: ServerLogService): BackupService {
  // One at a time. Each backup is a full copy of the database on disk, and two
  // clicks on the button should not mean two of those.
  let running = false;

  function removeSnapshot(path: string): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }

  /**
   * Clears snapshots a crash or a kill left behind. Only called while no backup
   * is running, so anything with the prefix is an orphan.
   */
  function sweepStaleSnapshots(): void {
    for (const name of readdirSync(config.dataDir)) {
      if (name.startsWith(SNAPSHOT_PREFIX)) rmSync(join(config.dataDir, name), { force: true });
    }
  }

  /**
   * The uploaded blobs, walked one shard at a time as the archive needs them.
   * Blobs are content-addressed and never rewritten, so reading them while the
   * server runs is safe. One written after the snapshot is simply unreferenced
   * in it, and retention tidies that up after a restore.
   */
  function* uploadEntries(now: Date): Generator<TarEntry> {
    let shards;
    try {
      shards = readdirSync(config.uploadDir, { withFileTypes: true });
    } catch {
      return; // Nothing has been uploaded yet.
    }
    yield { type: 'directory', name: 'uploads', mtime: now };
    for (const shard of shards.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(config.uploadDir, shard.name);
      yield { type: 'directory', name: `uploads/${shard.name}`, mtime: now };
      let files: string[];
      try {
        files = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const file of files) {
        yield { type: 'file', name: `uploads/${shard.name}/${file}`, path: join(dir, file), mtime: now };
      }
    }
  }

  return {
    async open(serverName) {
      if (running) {
        throw new HttpError(409, 'backup_in_progress', 'A backup is already being prepared. Try again shortly.');
      }
      running = true;

      const now = new Date();
      const snapshot = join(config.dataDir, `${SNAPSHOT_PREFIX}${randomUUID()}.db`);
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        try {
          removeSnapshot(snapshot);
        } finally {
          running = false;
        }
      };

      try {
        sweepStaleSnapshots();
        // SQLite's online backup copies the live database page by page into a
        // file of its own and restarts if another connection writes meanwhile,
        // so the result is one consistent point in time. Copying `harmony.db`
        // directly would not be: recent writes live in the WAL beside it.
        await backup(sqlite, snapshot);
      } catch (error) {
        finish();
        serverLog?.error('backup_failed', String(error));
        throw error;
      }

      function* entries(): Generator<TarEntry> {
        yield { type: 'file', name: BACKUP_DB_NAME, path: snapshot, mtime: now };
        yield* uploadEntries(now);
      }

      const source = Readable.from(tarStream(entries()), { objectMode: false });
      const gzip = createGzip();
      // `pipeline` tears both stages down together: a client that disconnects
      // destroys `gzip`, which stops the tar generator (closing the file it was
      // reading) before the callback runs and the snapshot is deleted.
      pipeline(source, gzip, () => finish());

      return { filename: `harmony-backup-${fileSlug(serverName, 'server')}-${fileDate(now)}.tar.gz`, stream: gzip, release: finish };
    },
  };
}
