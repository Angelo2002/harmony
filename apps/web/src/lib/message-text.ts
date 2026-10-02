import { RESERVED_MENTIONS, USERNAME_PATTERN, cleanUrl, matchChannelName, type Channel, type Emoji, type User } from '@harmony/shared';

/** Inline emphasis that can apply to a run of text. */
export interface TextStyles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  spoiler?: boolean;
}

export interface TextSegment {
  type: 'text';
  value: string;
  styles?: TextStyles;
}

export interface EmojiSegment {
  type: 'emoji';
  value: string;
  emoji: Emoji;
  styles?: TextStyles;
}

export interface MentionSegment {
  type: 'mention';
  value: string;
  user: User;
  styles?: TextStyles;
}

export interface ChannelSegment {
  type: 'channel';
  value: string;
  channel: Channel;
  styles?: TextStyles;
}

export interface LinkSegment {
  type: 'link';
  value: string;
  href: string;
  styles?: TextStyles;
  /** Set for masked and angle-bracket links, which should never be unfurled. */
  noEmbed?: boolean;
}

export interface CodeSegment {
  type: 'code';
  value: string;
  styles?: TextStyles;
}

export type InlineSegment = TextSegment | EmojiSegment | MentionSegment | ChannelSegment | LinkSegment | CodeSegment;

/** A block-level chunk of a message. Inline content is always inside one. */
export type MessageBlock =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'quote'; segments: InlineSegment[] }
  | { type: 'header'; level: number; segments: InlineSegment[] }
  | { type: 'code'; text: string; language: string | null };

/**
 * The inline grammar, tried left to right. Order matters: a backslash escape and
 * inline code win first, then the two-character emphasis markers before their
 * single-character forms, then links, and only then emoji and mentions, so a
 * `:name:` or `@name` inside a URL is never mistaken for one.
 *
 * Note the deliberate absence of the `i` flag: emoji shortcodes are
 * case-sensitive, so `:YES:` must not match `:yes:`.
 */
const INLINE_SOURCE = [
  '\\\\(?<esc>[*_~`|\\[\\]()>#])',
  '`(?<code>[^`\\n]*?)`',
  '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*',
  '__(?<underline>[\\s\\S]+?)__',
  '~~(?<strike>[\\s\\S]+?)~~',
  '\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|',
  '\\*(?<italicStar>[^*\\n]+?)\\*',
  '(?<![a-zA-Z0-9_])_(?<italicUnderscore>[^_\\n]+?)_(?![a-zA-Z0-9_])',
  '\\[(?<linkText>[^\\]\\n]+?)\\]\\((?<linkUrl>https?:\\/\\/[^\\s)]+)\\)',
  '<(?<autolink>https?:\\/\\/[^\\s>]+)>',
  ':(?<emojiName>[a-zA-Z0-9_]{2,32}):',
  `(?<![a-zA-Z0-9._-])@(?<mentionName>${USERNAME_PATTERN})`,
  '(?<bareUrl>https?:\\/\\/[^\\s<>]+)',
].join('|');

/** How deep emphasis may nest before the parser stops unwrapping it. */
const MAX_NESTING = 4;

function normalizeStyles(styles: TextStyles): TextStyles | undefined {
  return styles.bold || styles.italic || styles.underline || styles.strike || styles.spoiler
    ? styles
    : undefined;
}

function sameStyles(a: TextStyles | undefined, b: TextStyles | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.spoiler === !!b.spoiler
  );
}

/** Appends text, merging it into the previous run when the styling matches. */
function pushText(out: InlineSegment[], value: string, styles: TextStyles): void {
  if (value.length === 0) return;
  const normalized = normalizeStyles(styles);
  const last = out[out.length - 1];
  if (last && last.type === 'text' && sameStyles(last.styles, normalized)) {
    last.value += value;
    return;
  }
  out.push({ type: 'text', value, styles: normalized });
}

// What may not touch a `#` reference on either side.
const CHANNEL_NAME_CHAR = /[a-zA-Z0-9_-]/;

/**
 * Appends a stretch of plain text, splitting out any `#channel` references into
 * their own segments. A name with a space is handled here rather than in the
 * grammar, since only the channels that exist can say where a name ends.
 */
function emitText(
  out: InlineSegment[],
  value: string,
  styles: TextStyles,
  channels: readonly Channel[],
): void {
  if (channels.length === 0) {
    pushText(out, value, styles);
    return;
  }

  const names = channels.map((channel) => channel.name);
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const hash = value.indexOf('#', index);
    if (hash === -1) break;
    const before = hash > 0 ? value[hash - 1] : undefined;
    if (before !== undefined && CHANNEL_NAME_CHAR.test(before)) {
      index = hash + 1;
      continue;
    }
    const name = matchChannelName(value.slice(hash + 1), names);
    const channel = name === null ? undefined : channels.find((entry) => entry.name === name);
    if (!channel) {
      index = hash + 1;
      continue;
    }
    pushText(out, value.slice(cursor, hash), styles);
    out.push({ type: 'channel', value: name ?? channel.name, channel, styles: normalizeStyles(styles) });
    index = hash + 1 + channel.name.length;
    cursor = index;
  }
  pushText(out, value.slice(cursor), styles);
}

/** Splits one stretch of text into styled inline segments. */
function parseInline(
  text: string,
  emojiLookup: Map<string, Emoji>,
  mentionLookup: (username: string) => User | undefined,
  channels: readonly Channel[],
  styles: TextStyles,
  depth: number,
): InlineSegment[] {
  if (depth > MAX_NESTING) return [{ type: 'text', value: text, styles: normalizeStyles(styles) }];

  const pattern = new RegExp(INLINE_SOURCE, 'g');
  const out: InlineSegment[] = [];
  let cursor = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) emitText(out, text.slice(cursor, match.index), styles, channels);

    const group = match.groups ?? {};
    const nested = (inner: string, extra: TextStyles): void => {
      out.push(...parseInline(inner, emojiLookup, mentionLookup, channels, { ...styles, ...extra }, depth + 1));
    };

    if (group.esc !== undefined) {
      emitText(out, group.esc, styles, channels);
    } else if (group.code !== undefined) {
      out.push({ type: 'code', value: group.code, styles: normalizeStyles(styles) });
    } else if (group.bold !== undefined) {
      nested(group.bold, { bold: true });
    } else if (group.underline !== undefined) {
      nested(group.underline, { underline: true });
    } else if (group.strike !== undefined) {
      nested(group.strike, { strike: true });
    } else if (group.spoiler !== undefined) {
      nested(group.spoiler, { spoiler: true });
    } else if (group.italicStar !== undefined || group.italicUnderscore !== undefined) {
      nested(group.italicStar ?? group.italicUnderscore ?? '', { italic: true });
    } else if (group.linkText !== undefined) {
      out.push({
        type: 'link',
        value: group.linkText,
        href: group.linkUrl ?? '',
        styles: normalizeStyles(styles),
        noEmbed: true,
      });
    } else if (group.autolink !== undefined) {
      out.push({
        type: 'link',
        value: group.autolink,
        href: group.autolink,
        styles: normalizeStyles(styles),
        noEmbed: true,
      });
    } else if (group.emojiName !== undefined) {
      const emoji = emojiLookup.get(group.emojiName);
      if (emoji) out.push({ type: 'emoji', value: group.emojiName, emoji, styles: normalizeStyles(styles) });
      else emitText(out, match[0], styles, channels);
    } else if (group.mentionName !== undefined) {
      const user = RESERVED_MENTIONS.has(group.mentionName.toLowerCase())
        ? undefined
        : mentionLookup(group.mentionName);
      if (user) out.push({ type: 'mention', value: group.mentionName, user, styles: normalizeStyles(styles) });
      else emitText(out, match[0], styles, channels);
    } else if (group.bareUrl !== undefined) {
      const href = cleanUrl(group.bareUrl);
      out.push({ type: 'link', value: href, href, styles: normalizeStyles(styles) });
      // Anything the cleanup trimmed belongs to the surrounding text.
      emitText(out, group.bareUrl.slice(href.length), styles, channels);
    }

    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) emitText(out, text.slice(cursor), styles, channels);
  return out;
}

const FENCE = /^```(\S*)\s*$/;
const CLOSING_FENCE = /^```\s*$/;
const HEADER = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^>\s?/;

/**
 * Parses message text into blocks. Fenced code, headers and quotes are handled
 * a line at a time; everything else becomes a paragraph whose newlines are kept
 * by the renderer. Returns segments rather than HTML, so rendering can never
 * inject markup.
 */
export function parseMessage(
  content: string,
  emojiLookup: Map<string, Emoji>,
  mentionLookup: (username: string) => User | undefined,
  channels: readonly Channel[] = [],
): MessageBlock[] {
  const inline = (text: string): InlineSegment[] =>
    parseInline(text, emojiLookup, mentionLookup, channels, {}, 0);

  const lines = content.split('\n');
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', segments: inline(paragraph.join('\n')) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      index++;
      const body: string[] = [];
      while (index < lines.length && !CLOSING_FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index++;
      }
      if (index < lines.length) index++; // consume the closing fence
      blocks.push({ type: 'code', text: body.join('\n'), language: fence[1] || null });
      continue;
    }

    const header = HEADER.exec(line);
    if (header) {
      flushParagraph();
      blocks.push({ type: 'header', level: (header[1] ?? '').length, segments: inline(header[2] ?? '') });
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(QUOTE, ''));
        index++;
      }
      blocks.push({ type: 'quote', segments: inline(quote.join('\n')) });
      continue;
    }

    paragraph.push(line);
    index++;
  }

  flushParagraph();
  return blocks;
}
