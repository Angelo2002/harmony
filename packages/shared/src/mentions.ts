/**
 * `@username` mentions.
 *
 * Harmony usernames are unique and contain no spaces, which makes a mention
 * unambiguous: it is a literal `@` followed by a username. The same character
 * class is reused by the web client's tokenizer so the two can never disagree
 * about what a username looks like.
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
