import type { Message } from '@harmony/shared';

/**
 * Folds a freshly fetched newest page into the messages already loaded.
 *
 * Used when the client catches up after being away, where replacing the whole
 * list would throw away the older pages someone may have scrolled back to.
 * Anything already on screen keeps its place but takes the server's word for its
 * contents, so an edit or a reaction made meanwhile shows up; messages that were
 * never seen are added on the end, where they belong.
 */
export function mergeLatest(loaded: Message[], fresh: Message[]): Message[] {
  const byId = new Map(fresh.map((message) => [message.id, message]));
  const seen = new Set(loaded.map((message) => message.id));

  const merged = loaded.map((message) => byId.get(message.id) ?? message);
  for (const message of fresh) {
    if (!seen.has(message.id)) merged.push(message);
  }
  return merged;
}
