/**
 * Per-member mute and notification settings for channels and categories, the
 * same idea as Discord's. They live in `shared` so the server stores exactly the
 * choices the client offers, and so the rule for how a channel inherits from its
 * category is written once and can be tested without a browser.
 *
 * None of it changes what anyone else sees: a mute is one member's way of
 * quieting a channel for themselves, and nobody can tell it is there.
 */

/**
 * How much of a channel is worth a notification. `default` defers to the
 * category for a channel, and to the server default for a category.
 */
export const NOTIFICATION_LEVELS = ['default', 'all', 'mentions', 'nothing'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** A level with every `default` followed to the end. */
export type EffectiveNotificationLevel = Exclude<NotificationLevel, 'default'>;

/**
 * What `default` comes to when nothing above it says otherwise. Harmony is a
 * single community rather than a big public server, so every message counts,
 * which is also how it behaved before there were settings at all.
 */
export const SERVER_DEFAULT_NOTIFICATION_LEVEL: EffectiveNotificationLevel = 'all';

/** The longest timed mute the API accepts. Anything longer is "until I turn it back on". */
export const MAX_MUTE_SECONDS = 365 * 24 * 60 * 60;

/** The mute lengths the menus offer, mirroring Discord's list. `null` never ends. */
export const MUTE_DURATIONS: ReadonlyArray<{ seconds: number | null; label: string }> = [
  { seconds: 15 * 60, label: 'For 15 minutes' },
  { seconds: 60 * 60, label: 'For 1 hour' },
  { seconds: 3 * 60 * 60, label: 'For 3 hours' },
  { seconds: 8 * 60 * 60, label: 'For 8 hours' },
  { seconds: 24 * 60 * 60, label: 'For 24 hours' },
  { seconds: null, label: 'Until I turn it back on' },
];

/** Labels for the notification menu, in the order Discord lists them. */
export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
  default: 'Use category default',
  all: 'All messages',
  mentions: 'Only @mentions',
  nothing: 'Nothing',
};

/** One member's settings for one channel or category. */
export interface ChannelNotificationSettings {
  /** The channel or category these settings belong to. */
  targetId: string;
  targetType: 'channel' | 'category';
  /** Whether a mute is in force right now. An expired mute reads as `false`. */
  muted: boolean;
  /** When the mute lifts on its own, or null for one that lasts until undone (or no mute). */
  muteEndsAt: string | null;
  level: NotificationLevel;
}

/** Whether a stored mute is still in force at `now`. */
export function isMuteActive(
  settings: Pick<ChannelNotificationSettings, 'muted' | 'muteEndsAt'> | undefined,
  now: number = Date.now(),
): boolean {
  if (!settings?.muted) return false;
  return settings.muteEndsAt === null || Date.parse(settings.muteEndsAt) > now;
}

/** How a channel actually behaves once its own settings and its category's are combined. */
export interface ResolvedChannelSettings {
  muted: boolean;
  /**
   * When the mute that applies lifts, or null when it never does on its own (or
   * there is no mute). With both the channel and its category muted, the later
   * end wins, since the channel stays quiet until both have lifted.
   */
  muteEndsAt: string | null;
  /** True when the mute comes from the category rather than the channel itself. */
  mutedByCategory: boolean;
  level: EffectiveNotificationLevel;
}

/**
 * Combines a channel's settings with its category's, the way Discord does: a
 * muted category quiets every channel in it, and a channel left on "use
 * category default" takes the category's level, which in turn falls back to
 * the server default. A channel's own level always wins over its category's.
 */
export function resolveChannelSettings(
  channel: ChannelNotificationSettings | undefined,
  category: ChannelNotificationSettings | undefined,
  now: number = Date.now(),
): ResolvedChannelSettings {
  const ownMute = isMuteActive(channel, now);
  const categoryMute = isMuteActive(category, now);

  const ends: Array<string | null> = [];
  if (ownMute) ends.push(channel?.muteEndsAt ?? null);
  if (categoryMute) ends.push(category?.muteEndsAt ?? null);
  let muteEndsAt: string | null = null;
  for (const end of ends) {
    // Any mute without an end keeps the channel quiet indefinitely.
    if (end === null) {
      muteEndsAt = null;
      break;
    }
    if (muteEndsAt === null || end > muteEndsAt) muteEndsAt = end;
  }

  const ownLevel = channel?.level ?? 'default';
  const categoryLevel = category?.level ?? 'default';
  const level =
    ownLevel !== 'default'
      ? ownLevel
      : categoryLevel !== 'default'
        ? categoryLevel
        : SERVER_DEFAULT_NOTIFICATION_LEVEL;

  return { muted: ownMute || categoryMute, muteEndsAt, mutedByCategory: categoryMute && !ownMute, level };
}

/**
 * The soonest moment any of these mutes lifts on its own, as epoch milliseconds,
 * or null when none will. A client sets one timer for it so a mute ends on time
 * without a reload.
 */
export function nextMuteExpiry(
  settings: Iterable<Pick<ChannelNotificationSettings, 'muted' | 'muteEndsAt'>>,
  now: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const entry of settings) {
    if (!entry.muted || entry.muteEndsAt === null) continue;
    const end = Date.parse(entry.muteEndsAt);
    if (end > now && (soonest === null || end < soonest)) soonest = end;
  }
  return soonest;
}
