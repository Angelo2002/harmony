import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from './metadata.ts';

/**
 * Whether a hostname resolves only to addresses the server is willing to fetch
 * from. Shared by the metadata fetch and the preview-image proxy, so both draw
 * the same line against server-side request forgery.
 */
export async function resolvesToPublicHost(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return !isPrivateAddress(hostname);
  try {
    const records = await lookup(hostname, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}
