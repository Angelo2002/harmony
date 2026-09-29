import { isIP } from 'node:net';
import type { LinkEmbed } from '@harmony/shared';

/** How much of a page's metadata to keep. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;
const MAX_SITE_NAME = 100;

/** Only the head matters; this bounds how much of a large page we scan. */
const HEAD_LIMIT = 200_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
};

/** Decodes the handful of HTML entities that turn up in titles and descriptions. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Reads one attribute, trying double-quoted, single-quoted and bare forms. */
function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

interface MetaTag {
  key: string;
  content: string;
}

function metaTags(html: string): MetaTag[] {
  const tags: MetaTag[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, 'property') ?? attribute(tag, 'name');
    const content = attribute(tag, 'content');
    if (key && content !== null) tags.push({ key: key.toLowerCase(), content });
  }
  return tags;
}

function titleTag(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]) : null;
}

/** Collapses whitespace and trims a value to a sane length. */
function collapse(value: string | null, max: number): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Turns a possibly-relative image URL into an absolute http(s) one, or null. */
function absoluteHttpUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Builds a preview from a page's OpenGraph, Twitter-card or plain metadata.
 * Text is read here; the preview image is only referenced, never fetched, and
 * the client asks the server to proxy it when it wants to show it.
 */
export function parseEmbedMetadata(html: string, url: string): LinkEmbed {
  const head = html.slice(0, HEAD_LIMIT);
  const tags = metaTags(head);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const found = tags.find((tag) => tag.key === key && tag.content.trim().length > 0);
      if (found) return found.content;
    }
    return null;
  };

  return {
    url,
    title: collapse(pick('og:title', 'twitter:title') ?? titleTag(head), MAX_TITLE),
    description: collapse(pick('og:description', 'twitter:description', 'description'), MAX_DESCRIPTION),
    siteName: collapse(pick('og:site_name', 'application-name') ?? hostnameOf(url), MAX_SITE_NAME),
    imageUrl: absoluteHttpUrl(
      pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'),
      url,
    ),
  };
}

/**
 * Whether an address is one the server must never fetch from: loopback, private,
 * link-local, carrier-grade NAT, multicast or reserved. Anything that does not
 * parse as an IP is refused too, since callers only pass resolved addresses.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true;
}

function isPrivateV4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isPrivateV4(mapped);
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (/^fe[89ab]/.test(lower)) return true; // link-local
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}
