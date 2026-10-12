import { lookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as lookupAll } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { TcpNetConnectOpts } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateAddress } from './metadata.ts';

/** One address the guard approved for a host, and the IP family it belongs to. */
export interface PublicResolution {
  address: string;
  family: number;
}

/**
 * Resolves a hostname and decides whether the server is willing to connect to
 * it, returning the exact address to connect to or null when the name must not
 * be reached at all.
 *
 * An IP literal is judged directly and handed back unchanged. A name is allowed
 * only when *every* address it resolves to is public, so a record that answers
 * with both a public and a private address cannot smuggle the private one past
 * the check. Anything that fails to resolve is refused.
 *
 * The returned address is the one the caller may connect to: pinning the
 * connection to it, rather than letting fetch resolve the name again, is what
 * closes the DNS-rebinding window.
 */
export async function resolvePublicHost(hostname: string): Promise<PublicResolution | null> {
  const literal = isIP(hostname);
  if (literal !== 0) {
    return isPrivateAddress(hostname) ? null : { address: hostname, family: literal };
  }
  try {
    const records = await lookupAll(hostname, { all: true });
    if (records.length === 0) return null;
    if (records.some((record) => isPrivateAddress(record.address))) return null;
    const first = records[0];
    return first ? { address: first.address, family: first.family } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a hostname resolves only to addresses the server is willing to fetch
 * from. Shared by the metadata fetch and the preview-image proxy, so both draw
 * the same line against server-side request forgery.
 */
export async function resolvesToPublicHost(hostname: string): Promise<boolean> {
  return (await resolvePublicHost(hostname)) !== null;
}

/** The lookup signature `node:net` and undici's connector expect. */
type ConnectorLookup = NonNullable<TcpNetConnectOpts['lookup']>;

/** A resolution failure shaped like one `dns.lookup` would report. */
function blockedHostError(hostname: string): NodeJS.ErrnoException {
  const error = new Error(`refusing to connect to a private address for ${hostname}`) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

/**
 * The `lookup` the guarded dispatcher connects through: it re-resolves the name
 * at connection time and only ever hands the socket an address that passed the
 * same check `resolvePublicHost` makes. A name whose answer changed to a
 * private address between an earlier check and the connection is refused here,
 * before a socket to it is opened.
 */
const guardedLookup = ((
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
): void => {
  lookup(hostname, { family: options.family, hints: options.hints, all: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (addresses.length === 0 || addresses.some((record) => isPrivateAddress(record.address))) {
      callback(blockedHostError(hostname));
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(blockedHostError(hostname));
      return;
    }
    callback(null, first.address, first.family);
  });
}) as unknown as ConnectorLookup;

let guardedAgent: Agent | undefined;

/**
 * The dispatcher every outbound fetch to a member-supplied address goes
 * through. It is created once and reused: undici pools connections per origin,
 * and each new connection resolves and validates its target through
 * `guardedLookup`, so the address the request is sent to is the address that
 * was checked. Host and TLS SNI still come from the original hostname, because
 * only the resolved address is replaced, never the URL.
 */
function guardedDispatcher(): Agent {
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup } });
  return guardedAgent;
}

/**
 * A `fetch` that cannot be steered to a private address.
 *
 * Node's global `fetch` resolves the hostname itself, after any earlier guard
 * has run, so a name that rebinds between the check and the connection reaches
 * an internal address (SSRF via DNS rebinding). This fetch resolves and
 * validates the host first, then runs the request through a dispatcher whose
 * `lookup` validates again at connect time and returns the exact address it
 * approved. The request body is only ever written to a socket that passed the
 * guard.
 *
 * It is a drop-in `typeof fetch`, so a caller that injects its own fetch for a
 * test still wins.
 */
export const guardedFetch: typeof fetch = async (input, init) => {
  let target: URL;
  try {
    target = input instanceof URL ? input : new URL(input instanceof Request ? input.url : String(input));
  } catch {
    throw new TypeError('invalid url');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`unsupported protocol: ${target.protocol}`);
  }
  if (!(await resolvePublicHost(target.hostname))) {
    throw new Error(`blocked host: ${target.hostname}`);
  }
  const request = { ...(init as RequestInit | undefined), dispatcher: guardedDispatcher() };
  return (await undiciFetch(input as never, request as never)) as unknown as Response;
};
