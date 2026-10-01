import type { Message, User } from '@harmony/shared';
// The extension is deliberate: unlike the rest of the client's modules, this one
// is imported straight by Node in the text smoke test, which resolves nothing.
import { parseMessage } from './message-text.ts';

/**
 * Whether a message is aimed at one particular user: a reply to them, or their
 * name mentioned in the text. A name inside a code block is being quoted rather
 * than called, so it does not count.
 */
export function mentionsUser(
  message: Message,
  userId: string,
  resolve: (username: string) => User | undefined,
): boolean {
  if (message.replyTo?.author?.id === userId) return true;

  // Only mentions matter here, so the emoji lookup stays empty rather than
  // dragging the whole emoji list into a notification decision.
  const blocks = parseMessage(message.content, new Map(), resolve);
  return blocks.some(
    (block) =>
      block.type !== 'code' &&
      block.segments.some((segment) => segment.type === 'mention' && segment.user.id === userId),
  );
}

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
