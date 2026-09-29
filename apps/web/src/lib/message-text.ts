import { RESERVED_MENTIONS, USERNAME_PATTERN, type Emoji, type User } from '@harmony/shared';

export interface TextSegment {
  type: 'text';
  value: string;
}

export interface EmojiSegment {
  type: 'emoji';
  value: string;
  emoji: Emoji;
}

export interface MentionSegment {
  type: 'mention';
  value: string;
  user: User;
}

export type MessageSegment = TextSegment | EmojiSegment | MentionSegment;

/** A custom emoji `:name:` or a `@username` mention. */
function tokenPattern(): RegExp {
  // The lookbehind keeps an `@` inside an email or word from counting, matching
  // the shared mention parser.
  return new RegExp(`:([a-zA-Z0-9_]{2,32}):|(?<![a-zA-Z0-9._-])@(${USERNAME_PATTERN})`, 'g');
}

/**
 * Splits message text into plain text, custom emoji and mention segments.
 * Anything that does not resolve (an unknown shortcode, a reserved `@everyone`,
 * a username nobody has) stays literal text, so nothing is silently swallowed.
 * Returns segments rather than HTML, so rendering can never inject markup.
 */
export function tokenizeMessage(
  content: string,
  emojiLookup: Map<string, Emoji>,
  mentionLookup: (username: string) => User | undefined,
): MessageSegment[] {
  const pattern = tokenPattern();
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let match = pattern.exec(content);

  while (match !== null) {
    let segment: MessageSegment | null = null;
    const emojiName = match[1];
    const mentionName = match[2];

    if (emojiName !== undefined) {
      const emoji = emojiLookup.get(emojiName);
      if (emoji) segment = { type: 'emoji', value: emojiName, emoji };
    } else if (mentionName !== undefined && !RESERVED_MENTIONS.has(mentionName.toLowerCase())) {
      const user = mentionLookup(mentionName);
      if (user) segment = { type: 'mention', value: mentionName, user };
    }

    if (segment) {
      if (match.index > cursor) segments.push({ type: 'text', value: content.slice(cursor, match.index) });
      segments.push(segment);
      cursor = match.index + match[0].length;
    }
    match = pattern.exec(content);
  }

  if (cursor < content.length) segments.push({ type: 'text', value: content.slice(cursor) });
  return segments;
}
