import type { LinkEmbed } from '@harmony/shared';
import { collapseText } from './metadata.ts';

const FETCH_TIMEOUT_MS = 8000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;

/** YouTube ids are 11 URL-safe characters. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

/** The video id in a YouTube link, or null when the link is not one. */
export function youtubeVideoId(url: URL): string | null {
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  if (url.hostname.endsWith('youtu.be')) {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && YOUTUBE_ID.test(id) ? id : null;
  }
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return id && YOUTUBE_ID.test(id) ? id : null;
  }
  const [prefix, id] = url.pathname.split('/').filter(Boolean);
  if (prefix === 'shorts' || prefix === 'embed' || prefix === 'live' || prefix === 'v') {
    return id && YOUTUBE_ID.test(id) ? id : null;
  }
  return null;
}

const TWITTER_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.x.com',
  'mobile.twitter.com',
]);

const GIPHY_HOSTS = new Set(['giphy.com', 'www.giphy.com']);

/**
 * Whether a link is one of Giphy's pages for a gif, rather than a file of theirs
 * already. Their media addresses are handled as what they are, a link straight
 * at a picture.
 */
export function isGiphyPage(url: URL): boolean {
  if (!GIPHY_HOSTS.has(url.hostname.toLowerCase())) return false;
  return /^\/(?:gifs|embed)\//.test(url.pathname);
}

/**
 * The file behind one of Giphy's pages, through an endpoint of theirs that needs
 * no account and no key.
 *
 * The page itself is no help: it offers a still WebP and an animated GIF as two
 * preview images, and a page rewritten to a file address is the same thing as a
 * link straight at a gif, which is what a chat client should show. The address
 * asked is fixed, so the caller's URL cannot steer the request anywhere; where
 * Giphy points afterwards is checked by the caller like any other address.
 */
export async function fetchGiphyMedia(pageUrl: string, userAgent: string): Promise<string | null> {
  const endpoint = `https://giphy.com/services/oembed?url=${encodeURIComponent(pageUrl)}`;
  const response = await fetch(endpoint, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;

  const data = (await response.json().catch(() => null)) as { url?: unknown; type?: unknown } | null;
  if (!data || typeof data.url !== 'string') return null;

  try {
    const media = new URL(data.url);
    return media.protocol === 'http:' || media.protocol === 'https:' ? media.toString() : null;
  } catch {
    return null;
  }
}

/** Gif services whose page shows one gif, keyed by host with its page shape. */
const GIF_PAGE_HOSTS = new Map<string, RegExp>([
  ['tenor.com', /^\/view\//],
  ['klipy.com', /^\/gifs\//],
]);

/**
 * Whether a link is a page of a gif service that shows a single gif, rather than
 * a file of theirs already. These pages serve no file at their own address; they
 * name one in their preview metadata, so the picture is picked up from there
 * once the page has been read.
 *
 * Giphy is deliberately absent: it answers through an endpoint of its own, so it
 * is asked before a page is ever fetched.
 */
export function isGifPage(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = GIF_PAGE_HOSTS.get(host);
  return path !== undefined && path.test(url.pathname);
}

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DISCORD_ATTACHMENT_PATH = /^\/(?:attachments|ephemeral-attachments)\/(\d{15,25})\/(\d{15,25})\//;

/** The ids a Discord attachment link carries, or null when the link is not one. */
export interface DiscordAttachmentRef {
  channelId: string;
  attachmentId: string;
}

/**
 * The channel and attachment ids in a Discord CDN link, or null when the link is
 * not one. Discord signs these addresses and they expire, so the ids are what
 * lets the bridge ask Discord for a live address; the filename is not needed for
 * that and is left out.
 */
export function discordAttachment(url: URL): DiscordAttachmentRef | null {
  if (!DISCORD_CDN_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = DISCORD_ATTACHMENT_PATH.exec(url.pathname);
  if (!match) return null;
  const [, channelId, attachmentId] = match;
  if (!channelId || !attachmentId) return null;
  return { channelId, attachmentId };
}

/** The numeric status id in an X/Twitter link, or null when it is not one. */
export function tweetStatusId(url: URL): string | null {
  if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const id = segments[segments.indexOf('status') + 1];
  // Early tweets have tiny ids, so any run of digits counts.
  return id && /^\d{1,25}$/.test(id) ? id : null;
}

/**
 * Both providers answer over a small JSON endpoint rather than through the page,
 * which is quicker and does not depend on their HTML. Neither is official, so
 * each falls back to a plain scrape of the page if it fails.
 */
export async function fetchYouTubeEmbed(videoId: string, userAgent: string): Promise<LinkEmbed | null> {
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;

  const data = (await response.json().catch(() => null)) as
    | { title?: unknown; author_name?: unknown; thumbnail_url?: unknown }
    | null;
  if (!data || typeof data.title !== 'string') return null;

  return {
    url: watch,
    title: collapseText(data.title, MAX_TITLE),
    description: collapseText(typeof data.author_name === 'string' ? data.author_name : null, MAX_DESCRIPTION),
    siteName: 'YouTube',
    imageUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null,
    player: { provider: 'youtube', id: videoId },
  };
}

interface SyndicatedMedia {
  type?: string;
  media_url_https?: string;
}

interface SyndicatedTweet {
  text?: unknown;
  display_text_range?: unknown;
  mediaDetails?: unknown;
  user?: { name?: unknown; screen_name?: unknown };
}

/** X's embed endpoint wants a token derived from the status id. */
function tweetToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export async function fetchTweetEmbed(id: string, userAgent: string): Promise<LinkEmbed | null> {
  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tweetToken(id)}&lang=en`;
  const response = await fetch(endpoint, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;

  const tweet = (await response.json().catch(() => null)) as SyndicatedTweet | null;
  const name = typeof tweet?.user?.name === 'string' ? tweet.user.name : null;
  const handle = typeof tweet?.user?.screen_name === 'string' ? tweet.user.screen_name : null;
  if (!name && !handle) return null;

  // The media's t.co link is appended to the text; the image itself says more.
  let text = typeof tweet?.text === 'string' ? tweet.text : '';
  const range = tweet?.display_text_range;
  if (Array.isArray(range) && typeof range[0] === 'number' && typeof range[1] === 'number') {
    text = text.slice(range[0], range[1]);
  }

  const media = Array.isArray(tweet?.mediaDetails) ? (tweet.mediaDetails as SyndicatedMedia[]) : [];
  const photo = media.find((entry) => entry.type !== 'video' && typeof entry.media_url_https === 'string');

  return {
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    title: collapseText(name && handle ? `${name} (@${handle})` : (name ?? handle), MAX_TITLE),
    description: collapseText(text, MAX_DESCRIPTION),
    siteName: 'X',
    // A tweet with no media has no preview image; its avatar is not worth showing.
    imageUrl: photo?.media_url_https ?? null,
    player: null,
  };
}
