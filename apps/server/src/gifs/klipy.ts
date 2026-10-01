import type { GifSearchResult } from '@harmony/shared';

/** Klipy's API host. The key is part of the path, so every call stays server-side. */
const API_HOST = 'https://api.klipy.com';

/**
 * Whether an address belongs to Klipy. The picker only ever hands the server
 * addresses Klipy itself returned, so nothing else is fetched: a member cannot
 * turn the gif picker into a way to have the server fetch arbitrary pages.
 */
export function isKlipyAddress(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'klipy.com' || host.endsWith('.klipy.com');
}

/**
 * The search endpoint for a term, or Klipy's trending list when there is none.
 * `content_filter` is left at Klipy's own default; nothing here decides what is
 * suitable, an instance that minds can turn the tab off by removing the key.
 */
export function klipySearchUrl(key: string, query: { q?: string; limit: number }): string {
  const term = query.q?.trim() ?? '';
  const params = new URLSearchParams({
    page: '1',
    per_page: String(query.limit),
    locale: 'en',
  });
  if (term.length > 0) params.set('q', term);

  const route = term.length > 0 ? 'search' : 'trending';
  return `${API_HOST}/api/v1/${encodeURIComponent(key)}/gifs/${route}?${params.toString()}`;
}

/**
 * The sizes Klipy serves each gif at.
 *
 * Two orders, because the grid and the copy that gets kept want different things:
 * the copy is as large as is reasonable, while the tile is fetched through this
 * server and so is kept small — a page of full-size gifs would be megabytes
 * through the instance's own connection for every search.
 */
const KEPT_VARIANTS = ['md', 'hd', 'sm', 'xs'] as const;
const PREVIEW_VARIANTS = ['sm', 'xs', 'md', 'hd'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

interface SizedUrl {
  url: string;
  width: number | null;
  height: number | null;
}

/** One format of one gif, at the first size that offers it. */
function media(
  file: Record<string, unknown>,
  variants: readonly string[],
  formats: readonly string[],
): SizedUrl | null {
  for (const variant of variants) {
    const sizes = asRecord(file[variant]);
    for (const format of formats) {
      const chosen = asRecord(sizes?.[format]);
      const url = typeof chosen?.url === 'string' ? chosen.url : null;
      if (url) return { url, width: positiveNumber(chosen?.width), height: positiveNumber(chosen?.height) };
    }
  }
  return null;
}

/**
 * One gif from a search result. Only the gif format is taken: a result that has
 * no gif at any size is left out rather than saved as something the picker would
 * never list back, since the picker is gif-only throughout. The tile may fall back
 * to Klipy's still WebP, which is only ever displayed.
 */
function toResult(item: unknown): GifSearchResult | null {
  const record = asRecord(item);
  const file = asRecord(record?.file);
  if (!file) return null;

  const kept = media(file, KEPT_VARIANTS, ['gif']);
  if (!kept) return null;
  const preview = media(file, PREVIEW_VARIANTS, ['gif', 'webp']) ?? kept;

  const title = record?.title;
  return {
    url: kept.url,
    previewUrl: preview.url,
    width: kept.width,
    height: kept.height,
    title: typeof title === 'string' ? title : '',
  };
}

/**
 * The first list of objects inside a response. Klipy wraps its results a level or
 * two down (`{ result, data: { current_page, has_next, data: [...] } }`), and that
 * envelope is not something worth pinning the parser to, so the list is looked
 * for rather than assumed.
 */
function findItems(value: unknown, depth: number): unknown[] {
  if (Array.isArray(value)) return value;
  if (depth > 3) return [];
  const record = asRecord(value);
  if (!record) return [];

  for (const key of ['data', 'results', 'gifs', 'items']) {
    const found = findItems(record[key], depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

/** Turns one of Klipy's search responses into the shape the picker works with. */
export function normalizeKlipySearch(payload: unknown): GifSearchResult[] {
  const results: GifSearchResult[] = [];
  for (const item of findItems(payload, 0)) {
    const result = toResult(item);
    if (result) results.push(result);
  }
  return results;
}
