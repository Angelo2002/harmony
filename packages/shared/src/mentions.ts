/**
 * Text references: `@username` mentions and `#channel` references.
 *
 * Harmony usernames are unique and contain no spaces, which makes a mention
 * unambiguous: it is a literal `@` followed by a username. The same character
 * class is reused by the web client's tokenizer so the two can never disagree
 * about what a username looks like.
 *
 * A channel reference is different: a channel name may contain a space, so it
 * cannot be recognised by shape alone. It is resolved against the names that
 * actually exist instead, longest first, by the helpers below.
 */

/** The body of a username (without the surrounding `@`), as a regex fragment. */
export const USERNAME_PATTERN = '[a-zA-Z0-9._-]{2,32}';

// The lookbehind keeps an `@` inside an email or a word (a@b.com) from counting
// as a mention.
const MENTION = new RegExp(`(?<![a-zA-Z0-9._-])@(${USERNAME_PATTERN})`, 'g');

/** Tokens that look like mentions but are never resolved to a user. */
export const RESERVED_MENTIONS: ReadonlySet<string> = new Set(['everyone', 'here']);

/** The usernames mentioned in `text`, in order and without duplicates. */
export function listMentionUsernames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const name = match[1];
    if (!name) continue;
    if (RESERVED_MENTIONS.has(name.toLowerCase())) continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Rewrites every `@username` mention with `replace`, leaving the token untouched
 * when the callback returns null. Reserved tokens are never passed to `replace`.
 */
export function rewriteMentions(text: string, replace: (username: string) => string | null): string {
  return text.replace(MENTION, (whole, username: string) => {
    if (RESERVED_MENTIONS.has(username.toLowerCase())) return whole;
    return replace(username) ?? whole;
  });
}

// A channel reference is `#` followed by a channel's name. Unlike a username, a
// name may contain a space, so it cannot be matched by a pattern alone: it is
// resolved against the names that actually exist. This character class is just
// the boundary rule — what may not touch the reference on either side.
const CHANNEL_NAME_CHAR = /[a-zA-Z0-9_-]/;

/**
 * The longest known channel name that `text` begins with, or null. Matched
 * case-insensitively and only on a word boundary, so `#generalissimo` does not
 * match a channel called `general`. Longest-first is what lets a name with a
 * space win: `#Off Topic` must beat a channel called `Off`.
 */
export function matchChannelName(text: string, names: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (name.length === 0 || text.length < name.length) continue;
    if (best !== null && name.length <= best.length) continue;
    const after = text[name.length];
    if (after !== undefined && CHANNEL_NAME_CHAR.test(after)) continue;
    if (text.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    best = name;
  }
  return best;
}

/**
 * Rewrites every `#channel` whose name is known, leaving everything else —
 * including a `#name` that matches no channel — as written. The callback returns
 * the replacement, or null to leave the reference untouched.
 */
export function rewriteChannelMentions(
  text: string,
  names: readonly string[],
  replace: (name: string) => string | null,
): string {
  if (names.length === 0) return text;
  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const hash = text.indexOf('#', index);
    if (hash === -1) break;
    const before = hash > 0 ? text[hash - 1] : undefined;
    if (before !== undefined && CHANNEL_NAME_CHAR.test(before)) {
      index = hash + 1;
      continue;
    }
    const name = matchChannelName(text.slice(hash + 1), names);
    if (name === null) {
      index = hash + 1;
      continue;
    }
    out += text.slice(cursor, hash);
    out += replace(name) ?? `#${name}`;
    index = hash + 1 + name.length;
    cursor = index;
  }
  return out + text.slice(cursor);
}
