/**
 * Discord's dynamic timestamps, `<t:1700000000:R>`.
 *
 * The message carries a moment as unix seconds and a style letter; every reader
 * sees it in their own locale and time zone, which is the whole point of them:
 * "the stream starts <t:…:t>" reads right for everyone in the channel. The style
 * letters and what they show follow Discord's.
 */
export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** The style Discord falls back to when none is given. */
export const DEFAULT_TIMESTAMP_STYLE: TimestampStyle = 'f';

const ABSOLUTE: Record<Exclude<TimestampStyle, 'R'>, Intl.DateTimeFormatOptions> = {
  t: { hour: 'numeric', minute: '2-digit' },
  T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};

/** The largest unit that fits wins, so "in 3 hours" rather than "in 180 minutes". */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/** The latest moment a `Date` can hold, in seconds either side of 1970. */
const MAX_SECONDS = 8.64e12;

export interface TimestampOptions {
  /** What "now" is for a relative time; the caller keeps it ticking. */
  now?: number;
  /** Left unset in the client, so the reader's own locale and zone apply. */
  locale?: string;
  timeZone?: string;
}

export function isTimestampStyle(value: string): value is TimestampStyle {
  return value in ABSOLUTE || value === 'R';
}

/**
 * Turns the seconds in a `<t:…>` tag into milliseconds, or null when the number
 * is beyond what a date can hold. Such a tag is shown as written, as Discord does.
 */
export function timestampMs(seconds: string): number | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_SECONDS) return null;
  return value * 1000;
}

/** The text a timestamp shows in a given style. */
export function formatTimestamp(epochMs: number, style: TimestampStyle, options: TimestampOptions = {}): string {
  if (style === 'R') return formatRelative(epochMs, options);
  return new Intl.DateTimeFormat(options.locale, { ...ABSOLUTE[style], timeZone: options.timeZone }).format(epochMs);
}

/** The full date and time, for the tooltip behind every style. */
export function formatTimestampTitle(epochMs: number, options: TimestampOptions = {}): string {
  return formatTimestamp(epochMs, 'F', options);
}

function formatRelative(epochMs: number, options: TimestampOptions): string {
  const seconds = (epochMs - (options.now ?? Date.now())) / 1000;
  const [unit, size] = RELATIVE_UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['second', 1];
  // "always" keeps the count, so a year and a half ago reads "2 years ago"
  // rather than the vaguer "last year".
  return new Intl.RelativeTimeFormat(options.locale, { numeric: 'always' }).format(Math.round(seconds / size), unit);
}
