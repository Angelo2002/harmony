/**
 * The pure half of the quick switcher, the channel shortcuts and the unread
 * badge: matching, ranking, sidebar order and the tab title. It holds no state
 * and touches no DOM, which is what lets the text smoke test import it straight
 * into Node. Only the shapes it needs are named here, so the tests can hand it
 * plain objects rather than full channels and users.
 */

interface ChannelLike {
  id: string;
  name: string;
  categoryId: string | null;
}

interface CategoryLike {
  id: string;
  name: string;
}

interface MemberLike {
  id: string;
  username: string;
  displayName: string | null;
}

/** One row of the switcher, with what it needs to draw itself. */
export type SwitcherResult<C extends ChannelLike, M extends MemberLike> =
  | { kind: 'channel'; id: string; channel: C; category: string | null }
  | { kind: 'member'; id: string; member: M };

/**
 * Channels in the order the sidebar draws them: each category's channels in
 * turn, then the ones outside any category at the bottom. A channel whose
 * category is unknown is not drawn by the sidebar either, so it is left out
 * here rather than becoming a stop the arrows land on invisibly.
 */
export function sidebarOrder<C extends ChannelLike>(categories: readonly CategoryLike[], channels: readonly C[]): C[] {
  const ordered: C[] = [];
  for (const category of categories) {
    for (const channel of channels) {
      if (channel.categoryId === category.id) ordered.push(channel);
    }
  }
  for (const channel of channels) {
    if (channel.categoryId === null) ordered.push(channel);
  }
  return ordered;
}

/**
 * The channel one step away from `currentId` in `order`, going down for a
 * positive direction and up for a negative one, skipping any the filter turns
 * away. It wraps at either end, the way the sidebar arrows do in Discord, and
 * gives null when there is nowhere else to go. With no current channel the
 * first step lands on whichever end the direction starts from.
 */
export function stepChannel(
  order: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
  accept: (id: string) => boolean = () => true,
): string | null {
  const count = order.length;
  if (count === 0) return null;

  const current = currentId === null ? -1 : order.indexOf(currentId);
  const start = current === -1 ? (direction === 1 ? -1 : count) : current;
  for (let step = 1; step <= count; step++) {
    const index = (((start + direction * step) % count) + count) % count;
    const id = order[index];
    if (id === undefined || index === current) continue;
    if (accept(id)) return id;
  }
  return null;
}

/** Lower-cases and drops the separators people never type, for loose matching. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.]+/g, '');
}

/** The first letter of every word, so "gc" can find "general-chat". */
function initials(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) => word[0]).join('');
}

/**
 * How well a typed query fits a name, or null when it does not fit at all.
 * Higher is better, and the tiers are far enough apart that a shorter name only
 * ever breaks a tie inside one: an exact name beats a prefix, a prefix beats a
 * word inside the name, and so on down to the letters merely appearing in order,
 * which is what lets "gnrl" still find "general".
 */
export function matchScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = text.toLowerCase();
  // Shorter names win ties, since they are the closer fit for the same typing.
  const brevity = 1 / (1 + haystack.length);

  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 80 + brevity;

  const found = haystack.indexOf(needle);
  if (found > 0 && /[^a-z0-9]/.test(haystack[found - 1] ?? '')) return 60 + brevity;
  if (initials(text).startsWith(squash(needle)) && squash(needle).length > 1) return 50 + brevity;
  if (found !== -1) return 40 + brevity;

  // Letters in order with anything between them. Runs of consecutive letters
  // count for a little more, so "gen" in "general" outranks "g…e…n" elsewhere.
  const letters = squash(needle);
  const target = squash(text);
  // Nothing but separators typed, which every name would trivially "contain".
  if (letters.length === 0) return null;
  let position = 0;
  let runs = 0;
  let previous = -2;
  for (const letter of letters) {
    const at = target.indexOf(letter, position);
    if (at === -1) return null;
    if (at !== previous + 1) runs++;
    previous = at;
    position = at + 1;
  }
  return 20 - Math.min(runs, 10) + brevity;
}

/** The better of a member's display name and username, since either may be typed. */
function memberScore(query: string, member: MemberLike): number | null {
  const byUsername = matchScore(query, member.username);
  const byName = member.displayName ? matchScore(query, member.displayName) : null;
  if (byUsername === null) return byName;
  if (byName === null) return byUsername;
  return Math.max(byUsername, byName);
}

export interface RankInput<C extends ChannelLike, M extends MemberLike> {
  query: string;
  categories: readonly CategoryLike[];
  /** Every channel the member can see; the server never sends the others. */
  channels: readonly C[];
  members: readonly M[];
  /** Channels most recently opened first. */
  recentChannelIds: readonly string[];
  activeChannelId: string | null;
  limit?: number;
}

/**
 * What the switcher lists for a query. With nothing typed it is the channels
 * alone, most recently visited first and then in sidebar order, with the open
 * one last since going there is going nowhere. Once something is typed it is
 * every channel and member that matches, best match first, channels ahead of
 * members on a tie. A leading `#` keeps to channels and a leading `@` to
 * members, as in Discord; either prefix with nothing after it (a bare `#` or
 * `@`) lists that whole group as the empty query lists the channels.
 */
export function rankSwitcher<C extends ChannelLike, M extends MemberLike>(
  input: RankInput<C, M>,
): Array<SwitcherResult<C, M>> {
  const limit = input.limit ?? 50;
  const categoryName = new Map(input.categories.map((category) => [category.id, category.name]));
  const ordered = sidebarOrder(input.categories, input.channels);
  const orderIndex = new Map(ordered.map((channel, index) => [channel.id, index]));
  // Recent channels by how recent, then the rest, then the open one.
  const recentCount = input.recentChannelIds.length;
  const recency = (id: string): number => {
    if (id === input.activeChannelId) return recentCount + 1;
    const index = input.recentChannelIds.indexOf(id);
    return index === -1 ? recentCount : index;
  };
  const channelRow = (channel: C): SwitcherResult<C, M> => ({
    kind: 'channel',
    id: channel.id,
    channel,
    category: channel.categoryId === null ? null : (categoryName.get(channel.categoryId) ?? null),
  });

  let query = input.query.trim();
  let wantChannels = true;
  let wantMembers = true;
  if (query.startsWith('#')) {
    wantMembers = false;
    query = query.slice(1).trim();
  } else if (query.startsWith('@')) {
    wantChannels = false;
    query = query.slice(1).trim();
  }

  if (query.length === 0) {
    // A bare `@`, before any name is typed, lists the members so they can be
    // browsed; a bare `#` or an empty query still lists the channels alone.
    if (!wantChannels) {
      return input.members.slice(0, limit).map((member) => ({ kind: 'member', id: member.id, member }));
    }
    return ordered
      .slice()
      .sort((a, b) => recency(a.id) - recency(b.id) || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
      .slice(0, limit)
      .map(channelRow);
  }

  const scored: Array<{ row: SwitcherResult<C, M>; score: number; tie: number }> = [];
  if (wantChannels) {
    for (const channel of ordered) {
      const score = matchScore(query, channel.name);
      if (score === null) continue;
      // Recency first, then sidebar position, scaled so neither swamps the other.
      const tie = recency(channel.id) * 100000 + (orderIndex.get(channel.id) ?? 0);
      scored.push({ row: channelRow(channel), score, tie });
    }
  }
  if (wantMembers) {
    const firstMember = Number.MAX_SAFE_INTEGER / 2;
    input.members.forEach((member, index) => {
      const score = memberScore(query, member);
      if (score === null) return;
      scored.push({ row: { kind: 'member', id: member.id, member }, score, tie: firstMember + index });
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.tie - b.tie)
    .slice(0, limit)
    .map((entry) => entry.row);
}

/** How one channel's mute and notification level affect what it adds to the totals. */
interface NotifyLike {
  muted: boolean;
  level: string;
}

/**
 * What the tab title and app badge count, once mutes are taken into account,
 * the way Discord counts them: every unread mention, except in a channel set to
 * notify about nothing at all, and every channel with something unread, except
 * muted ones. A muted channel still counts when it holds a mention, since being
 * named is the one thing a mute lets through.
 *
 * Counted over the channels actually listed, so a stale id the server still
 * remembers for a channel this member can no longer see cannot keep the tab
 * marked with nothing in the sidebar to explain it.
 */
export function unreadSummary<C extends { id: string }>(
  channels: readonly C[],
  unread: ReadonlySet<string>,
  mentionCounts: Readonly<Record<string, number>>,
  settingsFor: (channel: C) => NotifyLike,
): { mentions: number; unread: number } {
  let mentions = 0;
  let unreadChannels = 0;
  for (const channel of channels) {
    const settings = settingsFor(channel);
    const mentioned = settings.level === 'nothing' ? 0 : (mentionCounts[channel.id] ?? 0);
    mentions += mentioned;
    if (mentioned > 0 || (unread.has(channel.id) && !settings.muted)) unreadChannels++;
  }
  return { mentions, unread: unreadChannels };
}

/**
 * The tab title for a server, marked the way Discord marks its own: the number
 * of unread mentions in brackets, or a dot when there is only ordinary unread
 * chatter, and the plain name when everything has been read.
 */
export function unreadTitle(serverName: string, mentions: number, unreadChannels: number): string {
  if (mentions > 0) return `(${mentions}) ${serverName}`;
  if (unreadChannels > 0) return `• ${serverName}`;
  return serverName;
}

/**
 * What the installed app's icon badge should show for the same counts: a
 * number for mentions, a bare dot for anything else unread, or nothing.
 */
export function unreadBadge(mentions: number, unreadChannels: number): number | 'dot' | null {
  if (mentions > 0) return mentions;
  if (unreadChannels > 0) return 'dot';
  return null;
}
