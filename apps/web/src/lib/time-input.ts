/**
 * The writing half of dynamic timestamps: turning what somebody types after an
 * `@`, or picks in the composer's clock popover, into a `<t:…:STYLE>` tag.
 *
 * Like the rendering half in `timestamp.ts` it holds no state and touches no
 * DOM. "Now", the locale and the time zone are always handed in, so the text
 * smoke test can pin them; in the client the locale and zone are left unset and
 * the writer's own apply, which is what they mean when they type "5pm".
 */
import { formatTimestamp, type TimestampStyle } from './timestamp.ts';

export interface TimeInputOptions {
  /** The moment "now", "in 2h" and "the next 5pm" are counted from. */
  now: number;
  /** Left unset in the client, so the writer's own locale and zone apply. */
  locale?: string;
  timeZone?: string;
}

/**
 * What an expression named, which decides the style offered first: a bare time
 * reads best as a time, a bare day as a date, and "in 2h" as a countdown.
 */
export type MomentKind = 'time' | 'date' | 'datetime' | 'relative' | 'now';

export interface ParsedMoment {
  epochMs: number;
  kind: MomentKind;
}

/** One style a moment can be written in, ready to show and to insert. */
export interface TimestampChoice {
  style: TimestampStyle;
  /** What the style is called, e.g. "short time". */
  name: string;
  /** How the tag will read, in the writer's own locale and zone. */
  preview: string;
  token: string;
}

/** Every style in Discord's order, which is also the order after the lead one. */
const STYLES: TimestampStyle[] = ['t', 'T', 'd', 'D', 'f', 'F', 'R'];

export const STYLE_NAMES: Record<TimestampStyle, string> = {
  t: 'short time',
  T: 'long time',
  d: 'short date',
  D: 'long date',
  f: 'date and time',
  F: 'full',
  R: 'relative',
};

const LEAD_STYLE: Record<MomentKind, TimestampStyle> = {
  time: 't',
  date: 'D',
  datetime: 'f',
  relative: 'R',
  now: 'f',
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RELATIVE_UNITS: Record<string, number> = {
  s: SECOND, sec: SECOND, secs: SECOND, second: SECOND, seconds: SECOND,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The tag a moment is written as. Discord's tags carry whole seconds. */
export function timestampToken(epochMs: number, style: TimestampStyle): string {
  return `<t:${Math.floor(epochMs / 1000)}:${style}>`;
}

/**
 * Reads a time expression, the text after the `@` without it, or returns null
 * when it is not one. Matching is whole and strict on purpose: the same `@`
 * starts a mention, so a near miss should stay a name rather than become a
 * time somebody did not mean.
 *
 * A time with no day is its next occurrence, today while it is still ahead and
 * tomorrow once it has passed; a day with no time keeps the current time of day.
 */
export function parseTimeExpression(input: string, options: TimeInputOptions): ParsedMoment | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text.length === 0 || text.length > 40) return null;
  // The tag holds whole seconds, so everything is counted from a whole second.
  const now = Math.floor(options.now / SECOND) * SECOND;

  if (text === 'now') return { epochMs: now, kind: 'now' };

  const relative = /^in (\d{1,4}|an?) ?([a-z]+)$/.exec(text);
  if (relative) {
    const [, amount = '', unitName = ''] = relative;
    const count = /^\d/.test(amount) ? Number(amount) : 1;
    const unit = RELATIVE_UNITS[unitName];
    // "in 0h" is just now, and nobody types it to mean that.
    if (unit === undefined || count === 0) return null;
    return { epochMs: now + count * unit, kind: 'relative' };
  }

  const today = wallClock(now, options.timeZone);

  const timeOnly = parseTime(text, false);
  if (timeOnly) {
    let moment = atTime(today, 0, timeOnly, options.timeZone);
    if (moment <= now) moment = atTime(today, 1, timeOnly, options.timeZone);
    return { epochMs: moment, kind: 'time' };
  }

  // A day, then optionally "at" and a time. After a day a bare hour is taken as
  // that hour, since "tomorrow 18" cannot mean anything else.
  const [, dayText = '', timeText] = /^(.+?)(?: (?:at )?(.+))?$/.exec(text) ?? [];
  const day = parseDay(dayText, options.locale);
  if (!day) return null;
  const time = timeText === undefined ? null : parseTime(timeText, true);
  if (timeText !== undefined && !time) return null;
  const clock = time ?? { hour: today.hour, minute: today.minute, second: 0 };
  const kind: MomentKind = time ? 'datetime' : 'date';

  switch (day.type) {
    case 'offset':
      return { epochMs: atTime(today, day.days, clock, options.timeZone), kind };
    case 'weekday': {
      // The coming such day. Today only counts when a time later today was
      // given: "monday" said on a Monday means the next one.
      const ahead = (day.weekday - today.weekday + 7) % 7;
      let moment = atTime(today, ahead, clock, options.timeZone);
      if (ahead === 0 && (!time || moment <= now)) moment = atTime(today, 7, clock, options.timeZone);
      return { epochMs: moment, kind };
    }
    case 'date': {
      if (day.year !== null) {
        return { epochMs: zonedEpoch({ ...day, year: day.year }, clock, options.timeZone), kind };
      }
      // Without a year it is the next such date, which may be today itself when
      // no time was given. The search runs past one year for 29 February, which
      // can be up to eight years away across a century.
      for (let year = today.year; year <= today.year + 8; year++) {
        const date = { year, month: day.month, day: day.day };
        if (!validDate(date)) continue;
        const moment = zonedEpoch(date, clock, options.timeZone);
        if (time ? moment > now : compareDates(date, today) >= 0) return { epochMs: moment, kind };
      }
      return null;
    }
  }
}

/**
 * Every style the moment can be written in, the one that suits what was typed
 * first. A time-only style says nothing of the day, so its preview names the
 * day too: whoever writes "5pm" should see whether that came out as today or
 * tomorrow, even though readers will only see the time.
 */
export function timestampChoices(moment: ParsedMoment, options: TimeInputOptions): TimestampChoice[] {
  const lead = LEAD_STYLE[moment.kind];
  const order = [lead, ...STYLES.filter((style) => style !== lead)];
  const format = { now: options.now, locale: options.locale, timeZone: options.timeZone };
  return order.map((style) => {
    const shown = formatTimestamp(moment.epochMs, style, format);
    const preview = style === 't' || style === 'T' ? `${dayName(moment.epochMs, options)} at ${shown}` : shown;
    return { style, name: STYLE_NAMES[style], preview, token: timestampToken(moment.epochMs, style) };
  });
}

/**
 * Whether the locale writes the day before the month, as `24/12` in most of the
 * world, or after it, as `12/24` in the US. Read from how the locale formats a
 * date rather than kept as a list of countries.
 */
export function dayFirst(locale?: string): boolean {
  const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(0);
  return parts.findIndex((part) => part.type === 'day') < parts.findIndex((part) => part.type === 'month');
}

/** The values a native date and time input hold for a moment, in the given zone. */
export function toDateTimeInputs(epochMs: number, timeZone?: string): { date: string; time: string } {
  const clock = wallClock(epochMs, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    date: `${String(clock.year).padStart(4, '0')}-${pad(clock.month)}-${pad(clock.day)}`,
    time: `${pad(clock.hour)}:${pad(clock.minute)}`,
  };
}

/** The moment a native date and time input describe, or null while either is incomplete. */
export function fromDateTimeInputs(date: string, time: string, timeZone?: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!day || !clock) return null;
  const calendar = { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) };
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (!validDate(calendar) || hour > 23 || minute > 59) return null;
  return zonedEpoch(calendar, { hour, minute, second: Number(clock[3] ?? 0) }, timeZone);
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ClockTime {
  hour: number;
  minute: number;
  second: number;
}

interface WallClock extends CalendarDate, ClockTime {
  /** 0 for Sunday, as `Date` counts. */
  weekday: number;
}

type Day =
  | { type: 'offset'; days: number }
  | { type: 'weekday'; weekday: number }
  | ({ type: 'date'; year: number | null } & Omit<CalendarDate, 'year'>);

/**
 * `5pm`, `5:30 pm`, `17:30`, `17:30:15`, `noon` and `midnight`. A bare number
 * is only an hour when `bareHour` says the context makes it one; on its own,
 * `@17` is more likely the start of a name.
 */
function parseTime(text: string, bareHour: boolean): ClockTime | null {
  if (text === 'noon') return { hour: 12, minute: 0, second: 0 };
  if (text === 'midnight') return { hour: 0, minute: 0, second: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))? ?(am|pm|a|p)?$/.exec(text);
  if (!match) return null;
  const [, hourText, minuteText, secondText, meridiem] = match;
  if (minuteText === undefined && meridiem === undefined && !bareHour) return null;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  if (minute > 59 || second > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.startsWith('p') ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute, second };
}

/**
 * `today`, `tomorrow`, `yesterday`, a weekday (three letters or more of it),
 * `2025-12-24`, or a day and month like `24/12` or `24.12.2025`, read in the
 * locale's order. When only one order makes a real date, as `24/12` does even
 * in the US, that one is taken.
 */
function parseDay(text: string, locale: string | undefined): Day | null {
  if (text === 'today') return { type: 'offset', days: 0 };
  if (text === 'tomorrow' || text === 'tmrw') return { type: 'offset', days: 1 };
  if (text === 'yesterday') return { type: 'offset', days: -1 };

  if (/^[a-z]{3,}$/.test(text)) {
    const weekday = WEEKDAYS.findIndex((name) => name.startsWith(text));
    return weekday === -1 ? null : { type: 'weekday', weekday };
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    return validDate(date) ? { type: 'date', ...date } : null;
  }

  const numeric = /^(\d{1,2})([/.])(\d{1,2})(?:\2(\d{4}))?$/.exec(text);
  if (!numeric) return null;
  const first = Number(numeric[1]);
  const second = Number(numeric[3]);
  const year = numeric[4] === undefined ? null : Number(numeric[4]);
  // Checked against a leap year, so 29/02 is not refused before the year is known.
  const fits = (day: number, month: number): boolean => validDate({ year: year ?? 2000, month, day });
  const [day, month] = dayFirst(locale) ? [first, second] : [second, first];
  if (fits(day, month)) return { type: 'date', year, month, day };
  if (fits(month, day)) return { type: 'date', year, month: day, day: month };
  return null;
}

function validDate({ year, month, day }: CalendarDate): boolean {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** What a wall clock in the zone shows at a moment. */
function wallClock(epochMs: number, timeZone: string | undefined): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(epochMs);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const date = { year: read('year'), month: read('month'), day: read('day') };
  return {
    ...date,
    // Some engines still write midnight as 24 even when asked for h23.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
    weekday: new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(),
  };
}

/**
 * The moment a wall clock in the zone shows the given date and time. The zone's
 * offset is only known for a moment, so it is guessed from the moment the same
 * reading would be in UTC and corrected; the second pass settles a guess that
 * landed across an offset change.
 */
function zonedEpoch(date: CalendarDate, clock: ClockTime, timeZone: string | undefined): number {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, clock.hour, clock.minute, clock.second);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const seen = wallClock(guess, timeZone);
    guess += wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  }
  return guess;
}

/** The given time, a number of days on from a day's date. */
function atTime(from: CalendarDate, days: number, clock: ClockTime, timeZone: string | undefined): number {
  const shifted = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
  const date = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
  return zonedEpoch(date, clock, timeZone);
}

/** "Today", "Tomorrow", a weekday within the coming week, or else the date. */
function dayName(epochMs: number, options: TimeInputOptions): string {
  const day = wallClock(epochMs, options.timeZone);
  const today = wallClock(options.now, options.timeZone);
  const days = Math.round(
    (Date.UTC(day.year, day.month - 1, day.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY,
  );
  if (Math.abs(days) <= 1) {
    const word = new Intl.RelativeTimeFormat(options.locale, { numeric: 'auto' }).format(days, 'day');
    return word.charAt(0).toLocaleUpperCase(options.locale) + word.slice(1);
  }
  if (days > 1 && days < 7) {
    return new Intl.DateTimeFormat(options.locale, { weekday: 'long', timeZone: options.timeZone }).format(epochMs);
  }
  return formatTimestamp(epochMs, 'd', { locale: options.locale, timeZone: options.timeZone });
}
