import type { Emoji } from '@harmony/shared';

export interface TextSegment {
  type: 'text';
  value: string;
}

export interface EmojiSegment {
  type: 'emoji';
  value: string;
  emoji: Emoji;
}

export type MessageSegment = TextSegment | EmojiSegment;

/**
 * Splits message text into plain-text and custom-emoji segments. Shortcodes
 * that do not match a known emoji are left as literal text, so nothing is
 * silently swallowed. Returns segments rather than HTML, so rendering can
 * never inject markup.
 */
export function tokenizeEmoji(content: string, lookup: Map<string, Emoji>): MessageSegment[] {
  const shortcode = /:([a-zA-Z0-9_]{2,32}):/g;
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let match = shortcode.exec(content);

  while (match !== null) {
    const emoji = lookup.get(match[1] ?? '');
    if (emoji) {
      if (match.index > cursor) segments.push({ type: 'text', value: content.slice(cursor, match.index) });
      segments.push({ type: 'emoji', value: emoji.name, emoji });
      cursor = match.index + match[0].length;
    }
    match = shortcode.exec(content);
  }

  if (cursor < content.length) segments.push({ type: 'text', value: content.slice(cursor) });
  return segments;
}
