/**
 * The pure half of going back and forward between channels: what a browser
 * history entry of ours holds, and what to do when the open channel changes or
 * the browser steps to another entry. It holds no state and touches no DOM, so
 * the text smoke test can import it straight into Node.
 *
 * Every channel opened gets a real history entry, rather than a list kept on
 * the side, because that is what the browser's own back and forward already
 * walk: its buttons, Alt+arrow and Cmd+bracket, a trackpad swipe, Android's back
 * gesture and the mouse's side buttons in a browser that handles them itself.
 * The URL does not name the channel. The entry's state is enough, and the
 * browser keeps it across a reload, which is how a reload stays in the channel
 * it was on.
 */

/** What one of our history entries carries, under its own key in `history.state`. */
export interface ChannelHistoryEntry {
  /** The channel the entry opens. */
  channelId: string;
  /**
   * The entry's position among ours. A step lands on an entry without saying
   * which way it went, so comparing positions is how back is told from forward.
   */
  index: number;
}

/** The key our entry sits under, so state anyone else puts there is left alone. */
const stateKey = 'harmonyChannel';

/** Reads our entry out of a `history.state`, or null when the state is not one of ours. */
export function readEntry(state: unknown): ChannelHistoryEntry | null {
  if (typeof state !== 'object' || state === null) return null;
  const entry: unknown = (state as Record<string, unknown>)[stateKey];
  if (typeof entry !== 'object' || entry === null) return null;
  const { channelId, index } = entry as Record<string, unknown>;
  if (typeof channelId !== 'string' || channelId.length === 0) return null;
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) return null;
  return { channelId, index };
}

/**
 * A `history.state` carrying `entry`, keeping whatever else `state` held. A
 * fresh entry passes null, since it should not inherit another entry's state.
 */
export function writeEntry(state: unknown, entry: ChannelHistoryEntry): Record<string, unknown> {
  const base = typeof state === 'object' && state !== null ? { ...(state as Record<string, unknown>) } : {};
  base[stateKey] = { channelId: entry.channelId, index: entry.index };
  return base;
}

/**
 * How a change of the open channel is written into history, given the entry
 * the page is on (`current`), whether that entry's channel still exists, and
 * the position to use when the page is on no entry of ours yet.
 *
 * - `push` adds an entry after the current one, so back returns to the
 *   channel being left.
 * - `replace` rewrites the entry the page is on. That is right for the first
 *   channel the page opens, which belongs on the entry it was loaded with, and
 *   for a channel that took over from one that has gone (deleted, or locked
 *   away), since going back to a channel that is gone would only land on the
 *   default again.
 * - null leaves history as it is: nothing is open, or the entry already names
 *   this channel, which is what a step back or forward looks like once it has
 *   opened its channel.
 */
export function planVisit(
  current: ChannelHistoryEntry | null,
  nextChannelId: string | null,
  currentStillExists: boolean,
  fallbackIndex: number,
): { op: 'push' | 'replace'; entry: ChannelHistoryEntry } | null {
  if (nextChannelId === null) return null;
  if (current === null) return { op: 'replace', entry: { channelId: nextChannelId, index: fallbackIndex } };
  if (current.channelId === nextChannelId) return null;
  return currentStillExists
    ? { op: 'push', entry: { channelId: nextChannelId, index: current.index + 1 } }
    : { op: 'replace', entry: { channelId: nextChannelId, index: current.index } };
}

/**
 * What to do when the browser has stepped onto one of our entries.
 *
 * - `open` opens the entry's channel.
 * - `skip` keeps going the same way: the entry names the channel already open,
 *   so stopping on it would make the press look like it did nothing.
 * - `stale` means the channel is gone. The entry is rewritten to the open
 *   channel, which also makes later steps skip it, and the step carries on.
 */
export function popAction(
  entry: ChannelHistoryEntry,
  activeChannelId: string | null,
  exists: boolean,
): 'open' | 'skip' | 'stale' {
  if (entry.channelId === activeChannelId) return 'skip';
  return exists ? 'open' : 'stale';
}

/**
 * Whether a skipped or stale step may carry on the same way from the entry at
 * `index`. Never back past the first of our entries, which is position 0: the
 * entry behind it is whatever page came before, and carrying on there would
 * leave the app over a press that only meant to change channel. Forward has no
 * such marker, but leaving forward means the member had already left this tab
 * for another page once, which the app itself never does.
 */
export function mayCarryOn(direction: -1 | 1, index: number): boolean {
  return direction === 1 || index > 0;
}

/** Which way a step from the entry at `from` to the one at `to` went: -1 back, 1 forward. */
export function stepDirection(from: number, to: number): -1 | 1 {
  return to < from ? -1 : 1;
}

/**
 * The history step a mouse button means: -1 for the back button and 1 for the
 * forward button, which `MouseEvent.button` numbers 3 and 4, and null for any
 * other button.
 */
export function mouseButtonStep(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}
