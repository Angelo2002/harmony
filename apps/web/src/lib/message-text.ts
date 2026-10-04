import { RESERVED_MENTIONS, USERNAME_PATTERN, cleanUrl, matchChannelName, type Channel, type Emoji, type User } from '@harmony/shared';
// The extension is deliberate: the text smoke test imports this module straight
// into Node, which resolves nothing on its own.
import { DEFAULT_TIMESTAMP_STYLE, isTimestampStyle, timestampMs, type TimestampStyle } from './timestamp.ts';

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

/** A Discord `<t:…>` timestamp; `value` is the tag as written. */
export interface TimestampSegment {
  type: 'timestamp';
  value: string;
  epochMs: number;
  style: TimestampStyle;
  styles?: TextStyles;
}

export type InlineSegment =
  | TextSegment
  | EmojiSegment
  | MentionSegment
  | ChannelSegment
  | LinkSegment
  | CodeSegment
  | TimestampSegment;

export interface ListItem {
  segments: InlineSegment[];
  /** Lists nested under this item, in order. */
  children: ListBlock[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  /** The number the first item shows; a numbered list may start anywhere. */
  start: number;
  items: ListItem[];
}

/** A block-level chunk of a message. Inline content is always inside one. */
export type MessageBlock =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'quote'; blocks: MessageBlock[] }
  | { type: 'header'; level: number; segments: InlineSegment[] }
  | { type: 'subtext'; segments: InlineSegment[] }
  | ListBlock
  | { type: 'code'; text: string; language: string | null };

/**
 * The inline grammar, tried left to right. Order matters: a backslash escape and
 * inline code win first, then the two-character emphasis markers before their
 * single-character forms, then links, and only then emoji and mentions, so a
 * `:name:` or `@name` inside a URL is never mistaken for one.
 *
 * An escape covers any ASCII punctuation, as on Discord, so `\@name`, `\:name:`
 * and `\<t:…>` show what was typed rather than what it would have become.
 *
 * Note the deliberate absence of the `i` flag: emoji shortcodes are
 * case-sensitive, so `:YES:` must not match `:yes:`.
 */
const INLINE_SOURCE = [
  '\\\\(?<esc>[!-\\/:-@\\[-`{-~])',
  '`(?<code>[^`\\n]*?)`',
  // Longest emphasis first: `***x***` is bold and italic, not a bold run with a
  // stranded star beside it.
  '\\*\\*\\*(?<boldItalicStar>[\\s\\S]+?)\\*\\*\\*',
  '___(?<boldItalicUnder>[\\s\\S]+?)___',
  '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*',
  '__(?<underline>[\\s\\S]+?)__',
  '~~(?<strike>[\\s\\S]+?)~~',
  '\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|',
  // Discord's rule: no space just inside the stars, so `2 * 3 * 4` is arithmetic.
  '\\*(?<italicStar>[^\\s*](?:[^*\\n]*?[^\\s*])?)\\*',
  '(?<![a-zA-Z0-9_])_(?<italicUnderscore>[^_\\n]+?)_(?![a-zA-Z0-9_])',
  // A masked link's address may hold balanced parentheses, as wiki paths do.
  '\\[(?<linkText>[^\\]\\n]+?)\\]\\((?<linkUrl>https?:\\/\\/[^\\s()]*(?:\\([^\\s()]*\\)[^\\s()]*)*)\\)',
  '<t:(?<timestamp>-?\\d{1,13})(?::(?<timestampStyle>[a-zA-Z]))?>',
  '<(?<autolink>https?:\\/\\/[^\\s>]+)>',
  ':(?<emojiName>[a-zA-Z0-9_]{2,32}):',
  `(?<![a-zA-Z0-9._-])@(?<mentionName>${USERNAME_PATTERN})`,
  '(?<bareUrl>https?:\\/\\/[^\\s<>]+)',
].join('|');

/**
 * The compiled inline grammar, built once. Each call of `parseInline` saves and
 * restores `lastIndex`, so the shared pattern survives the recursion intact.
 */
const INLINE_PATTERN = new RegExp(INLINE_SOURCE, 'g');

/** How deep emphasis may nest before the parser stops unwrapping it. */
const MAX_NESTING = 4;

/**
 * Markdown emphasis markers a bare URL can run into when a link touches styled
 * text. They belong to the message, not the address, so the parser trims them
 * back off and emits them as the text that follows.
 */
const TRAILING_MARKDOWN = /[*_~|]+$/;

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

/**
 * The text a segment shows, used when flattening a link label: an emoji, mention
 * or channel carries a bare name, so its marker is put back.
 */
function segmentText(segment: InlineSegment): string {
  if (segment.type === 'emoji') return `:${segment.value}:`;
  if (segment.type === 'mention') return `@${segment.value}`;
  if (segment.type === 'channel') return `#${segment.value}`;
  return segment.value;
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
    // The name must end at a word boundary as well, so `#chanx` never becomes a
    // channel `chan` with a stray `x` left over.
    const after = name === null ? undefined : value[hash + 1 + name.length];
    if (!channel || (after !== undefined && CHANNEL_NAME_CHAR.test(after))) {
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

  const pattern = INLINE_PATTERN;
  const resume = pattern.lastIndex;
  pattern.lastIndex = 0;
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
    } else if (group.boldItalicStar !== undefined || group.boldItalicUnder !== undefined) {
      nested(group.boldItalicStar ?? group.boldItalicUnder ?? '', { bold: true, italic: true });
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
      // Parse the label so emphasis and code inside it still apply; flatten the
      // runs into one link, carrying the styles they contributed.
      const label = parseInline(group.linkText, emojiLookup, mentionLookup, channels, styles, depth + 1);
      const link: TextStyles = { ...styles };
      let value = '';
      for (const segment of label) {
        value += segmentText(segment);
        if (!segment.styles) continue;
        if (segment.styles.bold) link.bold = true;
        if (segment.styles.italic) link.italic = true;
        if (segment.styles.underline) link.underline = true;
        if (segment.styles.strike) link.strike = true;
        if (segment.styles.spoiler) link.spoiler = true;
      }
      out.push({
        type: 'link',
        value,
        href: group.linkUrl ?? '',
        styles: normalizeStyles(link),
        noEmbed: true,
      });
    } else if (group.timestamp !== undefined) {
      // A style Discord does not know, or a moment no date can hold, leaves the
      // tag as written rather than guessing at what was meant.
      const style = group.timestampStyle ?? DEFAULT_TIMESTAMP_STYLE;
      const epochMs = timestampMs(group.timestamp);
      if (epochMs !== null && isTimestampStyle(style)) {
        out.push({ type: 'timestamp', value: match[0], epochMs, style, styles: normalizeStyles(styles) });
      } else {
        emitText(out, match[0], styles, channels);
      }
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
      const href = cleanUrl(group.bareUrl).replace(TRAILING_MARKDOWN, '');
      out.push({ type: 'link', value: href, href, styles: normalizeStyles(styles) });
      // Anything the cleanup trimmed belongs to the surrounding text.
      emitText(out, group.bareUrl.slice(href.length), styles, channels);
    }

    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) emitText(out, text.slice(cursor), styles, channels);
  pattern.lastIndex = resume;
  return out;
}

/** A fence opening a code block on a line of its own, with an optional language. */
const FENCE = /^(`{3,})(\S*)\s*$/;
/**
 * The end of a code block: at least as many backticks as opened it, finishing
 * the line, whether alone or straight after the last line of code.
 */
function closingFenceFor(backticks: number): RegExp {
  return new RegExp('^(.*?)`{' + backticks + ',}\\s*$');
}
/** A whole code block on one line, ```like this```. */
const SINGLE_LINE_FENCE = /^```(.+?)```\s*$/;
/** Discord's headers stop at three levels and need a space: `####` is just text. */
const HEADER = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT = /^-# +(\S.*)$/;
/**
 * `>>> ` quotes everything after it, `> ` a single line. Both need the space, as
 * on Discord, so a `>.<` or a `>>>` on its own stays the text it is.
 */
const QUOTE_REST = /^ *>>> /;
const QUOTE_LINE = /^ *> /;
/**
 * A bullet (`-` or `*`) or a number with a dot, then a space and something to
 * say. The space is what keeps `-5 degrees`, `*shrug*` and `1.5` out of lists.
 */
const LIST_ITEM = /^( *)([-*]|\d{1,9}\.) +(\S.*)$/;
/** A line with leading spaces, which inside a list carries on the item above. */
const INDENTED = /^ +\S/;
/** How much further in than its parent an item must sit to nest, as on Discord. */
const NEST_INDENT = 2;
/** Deeper items line up with the deepest list rather than stepping in forever. */
const MAX_LIST_DEPTH = 6;

/** A list as read from the lines, before its items are parsed for inline styles. */
interface RawList {
  ordered: boolean;
  start: number;
  /** How many spaces the list's own items are indented by. */
  indent: number;
  items: RawItem[];
  /** The item this list is nested under, or null at the top. */
  parent: RawItem | null;
}

interface RawItem {
  lines: string[];
  children: RawList[];
}

function newList(marker: string, indent: number, parent: RawItem | null): RawList {
  const ordered = marker !== '-' && marker !== '*';
  return { ordered, start: ordered ? Number.parseInt(marker, 10) : 1, indent, items: [], parent };
}

/**
 * Reads a run of list lines starting at `index`, which must be an item.
 *
 * Nesting follows indentation: an item at least two spaces further in than the
 * list above it starts a list under the previous item, and a shallower one goes
 * back to whichever open list it lines up with. Switching between bullets and
 * numbers under one item starts a sibling list there; at the top it ends this
 * list, so the caller starts the next one. The list ends at the first line that
 * is neither an item nor an indented continuation of one.
 */
function readList(lines: readonly string[], index: number): { list: RawList; next: number } {
  const first = LIST_ITEM.exec(lines[index] ?? '');
  const root = newList(first?.[2] ?? '-', first?.[1]?.length ?? 0, null);
  const open: RawList[] = [root];
  const deepest = (): RawList => open[open.length - 1] ?? root;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const item = LIST_ITEM.exec(line);

    if (!item) {
      if (!INDENTED.test(line)) break;
      deepest().items.at(-1)?.lines.push(line.trim());
      index++;
      continue;
    }

    const indent = (item[1] ?? '').length;
    const marker = item[2] ?? '-';
    const ordered = marker !== '-' && marker !== '*';

    while (open.length > 1 && indent < deepest().indent) open.pop();
    let list = deepest();
    const previous = list.items.at(-1);

    if (previous && indent >= list.indent + NEST_INDENT && open.length < MAX_LIST_DEPTH) {
      list = newList(marker, indent, previous);
      previous.children.push(list);
      open.push(list);
    } else if (list.ordered !== ordered) {
      if (!list.parent) break;
      const sibling = newList(marker, list.indent, list.parent);
      list.parent.children.push(sibling);
      open[open.length - 1] = sibling;
      list = sibling;
    }

    list.items.push({ lines: [item[3] ?? ''], children: [] });
    index++;
  }

  return { list: root, next: index };
}

/**
 * Parses message text into blocks. Code, headers, subtext, quotes and lists are
 * recognised a line at a time; everything else becomes a paragraph whose
 * newlines are kept by the renderer. Returns segments rather than HTML, so
 * rendering can never inject markup.
 */
export function parseMessage(
  content: string,
  emojiLookup: Map<string, Emoji>,
  mentionLookup: (username: string) => User | undefined,
  channels: readonly Channel[] = [],
): MessageBlock[] {
  const inline = (text: string): InlineSegment[] =>
    parseInline(text, emojiLookup, mentionLookup, channels, {}, 0);
  return parseBlocks(content.split('\n'), inline, true);
}

/**
 * The block grammar over a run of lines. A quote's lines go through it again
 * with their markers removed, so a quote can hold headers, lists and code the
 * way Discord's do; quotes themselves do not nest, on Discord or here.
 */
function parseBlocks(
  lines: readonly string[],
  inline: (text: string) => InlineSegment[],
  allowQuotes: boolean,
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', segments: inline(paragraph.join('\n')) });
    paragraph = [];
  };

  const toBlock = (list: RawList): ListBlock => ({
    type: 'list',
    ordered: list.ordered,
    start: list.start,
    items: list.items.map((item) => ({
      segments: inline(item.lines.join('\n')),
      children: item.children.map(toBlock),
    })),
  });

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const singleLine = SINGLE_LINE_FENCE.exec(line);
    if (singleLine) {
      flushParagraph();
      blocks.push({ type: 'code', text: singleLine[1] ?? '', language: null });
      index++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      index++;
      const body: string[] = [];
      const closingFence = closingFenceFor((fence[1] ?? '```').length);
      while (index < lines.length) {
        const closing = closingFence.exec(lines[index] ?? '');
        index++;
        if (closing) {
          if (closing[1]) body.push(closing[1]);
          break;
        }
        body.push(lines[index - 1] ?? '');
      }
      blocks.push({ type: 'code', text: body.join('\n'), language: fence[2] || null });
      continue;
    }

    const header = HEADER.exec(line);
    if (header) {
      flushParagraph();
      blocks.push({ type: 'header', level: (header[1] ?? '').length, segments: inline(header[2] ?? '') });
      index++;
      continue;
    }

    const subtext = SUBTEXT.exec(line);
    if (subtext) {
      flushParagraph();
      blocks.push({ type: 'subtext', segments: inline(subtext[1] ?? '') });
      index++;
      continue;
    }

    if (allowQuotes && QUOTE_REST.test(line)) {
      flushParagraph();
      const rest = [line.replace(QUOTE_REST, ''), ...lines.slice(index + 1)];
      blocks.push({ type: 'quote', blocks: parseBlocks(rest, inline, false) });
      index = lines.length;
      continue;
    }

    if (allowQuotes && QUOTE_LINE.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && QUOTE_LINE.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(QUOTE_LINE, ''));
        index++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quote, inline, false) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const { list, next } = readList(lines, index);
      blocks.push(toBlock(list));
      index = next;
      continue;
    }

    paragraph.push(line);
    index++;
  }

  flushParagraph();
  return blocks;
}

/**
 * Every inline segment outside code, from every block however deeply nested:
 * what a caller wants when asking whether a message mentions someone.
 */
export function inlineSegmentsOf(blocks: readonly MessageBlock[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  const visitList = (list: ListBlock): void => {
    for (const item of list.items) {
      out.push(...item.segments);
      item.children.forEach(visitList);
    }
  };
  for (const block of blocks) {
    if (block.type === 'code') continue;
    if (block.type === 'quote') out.push(...inlineSegmentsOf(block.blocks));
    else if (block.type === 'list') visitList(block);
    else out.push(...block.segments);
  }
  return out;
}
