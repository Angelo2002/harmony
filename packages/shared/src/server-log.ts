/**
 * The instance's own server log: what the server did, and where it failed. It is
 * distinct from the audit log, which records what *people* did. Reading it is
 * owner-only, because entries can carry internals (paths, SQL, failed requests)
 * that a moderated administrator should not necessarily see.
 *
 * Everything written here is sanitized first, so no token, password or other
 * secret ever lands in the table (see the server's log/sanitize.ts).
 */

/** The severity of a server-log entry. */
export type ServerLogLevel = 'info' | 'warn' | 'error';

/**
 * One entry, newest first. A repeated error is coalesced onto one row rather than
 * written per occurrence: `count` is how many times the same event and message
 * were seen, and `firstAt`/`lastAt` bracket the run. Informational events are not
 * coalesced — each is a distinct thing that happened.
 */
export interface ServerLogEntry {
  id: string;
  level: ServerLogLevel;
  /**
   * A stable code for the kind of event, e.g. 'instance_started',
   * 'retention_applied', 'bridge_channel_linked', 'unhandled_error'. Clients can
   * group or filter on it.
   */
  event: string;
  /** Sanitized, human-readable text. */
  message: string;
  /** Sanitized structured context; never secrets. */
  detail: Record<string, unknown>;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface ServerLogListResponse {
  entries: ServerLogEntry[];
}
