/**
 * The push contract a mobile shell is written against. It is the shape the
 * fan-out in `docs/PUSH.md` would deliver, and the one the launcher's router
 * reads by name, so the routing does not have to change when push ships.
 *
 * Harmony records one endpoint per install per account; delivery itself is not
 * built yet, so this only fixes the field names both sides agree on before
 * anything sends.
 */

/**
 * The notification a push provider would deliver to an install. The client
 * router reads these fields by name, so they are stable; the comment on each is
 * the meaning, not a license to rename.
 */
export interface PushPayload {
  /** Routing key: the instance's stable id, or its origin as a fallback. */
  instanceId: string;
  /** Display name, for a fallback when the icon is missing. */
  instanceName: string;
  /** Instance icon, or `null`. */
  iconUrl: string | null;
  /** Channel to open. */
  channelId: string;
  /** Channel name, for the notification text. */
  channelName: string;
  /** Message to scroll to. */
  messageId: string;
  /** Why the member was notified. */
  kind: 'mention' | 'reply';
  /** Who sent it. */
  authorName: string;
  /** Short preview, or `null`. */
  snippet: string | null;
}
