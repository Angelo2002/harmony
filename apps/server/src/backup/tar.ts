import { open } from 'node:fs/promises';

/**
 * Just enough of the tar format to write a backup: regular files and
 * directories in the POSIX ustar layout, which every `tar` (GNU, bsdtar, the
 * one shipped with Windows) extracts.
 *
 * It is written here rather than pulled in as a dependency because the whole
 * format is a 512-byte header per entry followed by the bytes padded to a
 * 512-byte boundary, and a backup only ever needs the writing half.
 */

const BLOCK = 512;
/** Read size when streaming a file into the archive. */
const CHUNK = 64 * 1024;
/** The largest size an 11-digit octal field holds; past it, sizes go in binary. */
const MAX_OCTAL_SIZE = 0o77777777777;

/** One entry to put in the archive. */
export type TarEntry =
  | { type: 'directory'; name: string; mtime: Date }
  | { type: 'file'; name: string; path: string; mtime: Date };

function writeString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value, offset, length, 'utf8');
}

/** A zero-padded octal number, NUL terminated, filling `length` bytes. */
function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  writeString(header, value.toString(8).padStart(length - 1, '0'), offset, length - 1);
}

/**
 * The size field. Anything past 8 GiB does not fit in octal, so it switches to
 * the base-256 form GNU tar introduced: the high bit of the first byte set, then
 * the number big-endian. A large database is the case this exists for.
 */
function writeSize(header: Buffer, size: number, offset: number): void {
  if (size <= MAX_OCTAL_SIZE) {
    writeOctal(header, size, offset, 12);
    return;
  }
  header.fill(0, offset, offset + 12);
  header[offset] = 0x80;
  let remaining = BigInt(size);
  for (let index = offset + 11; index > offset && remaining > 0n; index--) {
    header[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

/**
 * Splits a long path across ustar's `prefix` and `name` fields. Backup paths
 * are short (`uploads/ab/<64 hex>` is 75 characters), so this only guards
 * against a future caller handing in something that would silently truncate.
 */
function splitName(name: string): { prefix: string; name: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  const cut = name.lastIndexOf('/', 155);
  const prefix = cut > 0 ? name.slice(0, cut) : '';
  const rest = cut > 0 ? name.slice(cut + 1) : name;
  if (cut <= 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(rest) > 100) {
    throw new Error(`Path too long for a tar header: ${name}`);
  }
  return { prefix, name: rest };
}

function header(entry: { name: string; size: number; mtime: Date; directory: boolean }): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { prefix, name } = splitName(entry.name);

  writeString(block, name, 0, 100);
  writeOctal(block, entry.directory ? 0o755 : 0o644, 100, 8);
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeSize(block, entry.size, 124);
  writeOctal(block, Math.floor(entry.mtime.getTime() / 1000), 136, 12);
  // The checksum is computed with its own field read as spaces.
  block.fill(0x20, 148, 156);
  block[156] = (entry.directory ? '5' : '0').charCodeAt(0);
  writeString(block, 'ustar\0', 257, 6);
  writeString(block, '00', 263, 2);
  writeString(block, prefix, 345, 155);

  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** Zero bytes that take `size` up to the next block boundary. */
function padding(size: number): Buffer {
  const over = size % BLOCK;
  return Buffer.alloc(over === 0 ? 0 : BLOCK - over);
}

/**
 * Yields the archive a piece at a time, reading each file only as the consumer
 * asks for more, so memory stays at one chunk however large the backup is.
 *
 * Entries come from an iterable rather than a list so the caller can walk a
 * directory lazily. A file that has gone by the time it is reached (retention
 * pruned it, say) is skipped rather than failing the whole archive: its header
 * has not been written yet, so nothing is left half-done.
 */
export async function* tarStream(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    if (entry.type === 'directory') {
      const name = entry.name.endsWith('/') ? entry.name : `${entry.name}/`;
      yield header({ name, size: 0, mtime: entry.mtime, directory: true });
      continue;
    }

    let handle;
    try {
      handle = await open(entry.path, 'r');
    } catch {
      continue;
    }

    try {
      // The size comes from the open handle, so the header and the bytes that
      // follow it describe the same file even if the path is replaced meanwhile.
      const { size } = await handle.stat();
      yield header({ name: entry.name, size, mtime: entry.mtime, directory: false });

      let position = 0;
      let truncated = false;
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, size - position));
        // A file cut short underneath us still has to fill the size its header
        // promised, or every entry after it would be misread. Zeros keep the
        // archive well formed; the file itself is lost either way.
        const bytesRead = truncated ? 0 : (await handle.read(buffer, 0, buffer.length, position)).bytesRead;
        if (bytesRead === 0) {
          truncated = true;
          yield buffer;
          position += buffer.length;
          continue;
        }
        yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
        position += bytesRead;
      }
      yield padding(size);
    } finally {
      // Closed here rather than left to the garbage collector, so the caller can
      // delete a temporary file straight afterwards (Windows refuses while open).
      await handle.close();
    }
  }

  // Two empty blocks mark the end of the archive.
  yield Buffer.alloc(BLOCK * 2);
}
