/**
 * The unicode emoji set, from the unicode-emoji-json package.
 *
 * That data is the RGI subset — the emoji likely to render everywhere — with
 * skin tone variants collapsed onto the emoji they belong to, so 👋 stands in
 * for all five of its tones rather than six near-identical entries.
 *
 * It is a few hundred kilobytes of JSON. Fetching it on first use rather than
 * shipping it with the app keeps the client small for the many sessions that
 * never open an emoji picker, and lets the picker show the instance's own emoji
 * immediately instead of waiting on it.
 */
export interface UnicodeEmoji {
  /** The character to insert, e.g. "😀". */
  emoji: string;
  /** The CLDR name, e.g. "grinning face". Used for the tooltip and for search. */
  name: string;
}

export interface UnicodeEmojiGroup {
  /** Unicode's own grouping, e.g. "Smileys & Emotion". */
  name: string;
  emojis: UnicodeEmoji[];
}

/** The shape the package ships, before it is narrowed to what is used here. */
interface RawEmoji {
  emoji: string;
  name: string;
}

interface RawGroup {
  name: string;
  emojis: RawEmoji[];
}

let pending: Promise<UnicodeEmojiGroup[]> | null = null;

/**
 * Loads the unicode set, once. Every later call gets the first result, and a
 * failure is not remembered, so a member who was offline when the picker opened
 * gets another chance rather than a permanently empty list.
 */
export function loadUnicodeEmoji(): Promise<UnicodeEmojiGroup[]> {
  pending ??= import('unicode-emoji-json/data-by-group.json')
    .then((module) => narrow(module.default as unknown as RawGroup[]))
    .catch((cause: unknown) => {
      pending = null;
      throw cause;
    });
  return pending;
}

/** Drops the fields this client has no use for, and any group left empty. */
function narrow(groups: RawGroup[]): UnicodeEmojiGroup[] {
  return groups
    .map((group) => ({
      name: group.name,
      emojis: group.emojis.map((emoji) => ({ emoji: emoji.emoji, name: emoji.name })),
    }))
    .filter((group) => group.emojis.length > 0);
}

/**
 * The items whose name contains the query, case-insensitively. An empty query
 * matches everything, which is what lets one search box serve both browsing and
 * searching.
 */
export function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) => item.name.toLowerCase().includes(needle));
}

/** The same filter, applied to each group, dropping the ones left with nothing. */
export function filterUnicodeGroups(groups: UnicodeEmojiGroup[], query: string): UnicodeEmojiGroup[] {
  return groups
    .map((group) => ({ name: group.name, emojis: filterByName(group.emojis, query) }))
    .filter((group) => group.emojis.length > 0);
}
