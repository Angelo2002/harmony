import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { GatewayEvent, listEmbeddableUrls, type LinkEmbed, type Message } from '@harmony/shared';
import { setMessageEmbed } from '../db/messages.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import { isPrivateAddress, parseEmbedMetadata } from './metadata.ts';

/** Outbound fetch limits, kept tight because the target is user-supplied. */
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const USER_AGENT = 'Harmony/1.0 link-preview';
/** Remember at most this many results before starting over. */
const CACHE_LIMIT = 500;

export interface EmbedService {
  /**
   * Looks up a preview for a message's first embeddable link and stores it.
   * Best effort and asynchronous: a failure just leaves no preview.
   */
  resolve(messageId: string, content: string): void;
}

export interface EmbedServiceDeps {
  sqlite: DatabaseSync;
  settings: SettingsService;
  hub: GatewayHub;
  /** Renders a message for a broadcast, or null when it is gone. */
  renderMessage: (messageId: string) => Message | null;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Unfurls one link per message into a small text preview.
 *
 * The target URL comes from message text, so every hop is treated as hostile:
 * only http and https are allowed, the host must resolve to a public address,
 * redirects are followed manually and re-checked, and the response is bounded by
 * a timeout, a content-type check and a byte cap. Results are cached per URL,
 * including failures, so a dead link is not refetched for every message.
 */
export function createEmbedService(deps: EmbedServiceDeps): EmbedService {
  const cache = new Map<string, LinkEmbed | null>();
  const inFlight = new Map<string, Promise<LinkEmbed | null>>();

  function broadcast(messageId: string): void {
    const message = deps.renderMessage(messageId);
    if (!message) return;
    // Straight to the websocket clients: routing this through the message
    // service's edit listeners would let the bridge mistake it for a user edit.
    deps.hub.dispatch(GatewayEvent.MessageUpdate, message);
  }

  async function lookup(url: string): Promise<LinkEmbed | null> {
    if (cache.has(url)) return cache.get(url) ?? null;

    const pending = inFlight.get(url);
    if (pending) return pending;

    const job = fetchEmbed(url)
      .catch(() => null)
      .then((embed) => {
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(url, embed);
        return embed;
      })
      .finally(() => inFlight.delete(url));

    inFlight.set(url, job);
    return job;
  }

  return {
    resolve(messageId, content) {
      if (!deps.settings.get().embedsEnabled) return;
      const url = listEmbeddableUrls(content)[0];
      if (!url) return;

      void lookup(url)
        .then((embed) => {
          // A message deleted while we were fetching simply changes nothing.
          if (!setMessageEmbed(deps.sqlite, messageId, embed ? JSON.stringify(embed) : null)) return;
          broadcast(messageId);
        })
        .catch((error: unknown) => deps.log?.('link preview failed', { error: String(error) }));
    },
  };
}

/** Whether a hostname resolves only to addresses we are willing to fetch. */
async function resolvesToPublicHost(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return !isPrivateAddress(hostname);
  try {
    const records = await lookup(hostname, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}

async function fetchEmbed(url: string): Promise<LinkEmbed | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!(await resolvesToPublicHost(target.hostname))) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(contentType)) return null;

      return parseEmbedMetadata(await readCapped(response), target.toString());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Reads a response body up to a byte cap, then stops early. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // A truncated or aborted body is still worth parsing.
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}
