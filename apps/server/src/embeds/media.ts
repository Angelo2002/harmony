import { resolvesToPublicHost } from './guard.ts';

/** Outbound fetch limits, kept tight because the target is user-supplied. */
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const USER_AGENT = 'Harmony/1.0 link-preview';

export interface EmbedMedia {
  data: Buffer;
  contentType: string;
}

/**
 * Fetches a preview image for a client, so the browser never contacts the third
 * party itself: the viewer's address stays private, and an http-only image still
 * loads on an https page. The URL comes from message text, so every hop is
 * checked with the same guard the metadata fetch uses, the response must be an
 * image, and its size is capped.
 */
export async function fetchEmbedMedia(url: string): Promise<EmbedMedia | null> {
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
        headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) return null;

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) return null;
      // SVG can carry script, which would run if the proxy URL were opened
      // directly, so it is refused rather than served from our origin.
      if (contentType.includes('svg') || contentType.includes('+xml')) return null;

      const data = await readCapped(response, MAX_MEDIA_BYTES);
      if (!data || data.length === 0) return null;
      return { data, contentType };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Reads a body up to a byte cap, or null when it is empty or over the cap. */
async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks);
}
