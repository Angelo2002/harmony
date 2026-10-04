import type { DatabaseSync } from 'node:sqlite';

export interface ServerLogRow {
  id: string;
  level: string;
  event: string;
  message: string;
  detail: string | null;
  count: number;
  first_at: string;
  last_at: string;
}

export function insertServerLog(
  sqlite: DatabaseSync,
  input: {
    id: string;
    level: string;
    event: string;
    message: string;
    detail: string | null;
    firstAt: string;
    lastAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO server_log (id, level, event, message, detail, count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(input.id, input.level, input.event, input.message, input.detail, input.firstAt, input.lastAt);
}

/**
 * Folds a repeat onto the most recent row with the same event and message when
 * it happened within `since`, bumping its count and `last_at`. Returns whether
 * a row was found; the caller inserts a fresh one when it was not.
 */
export function coalesceServerLog(
  sqlite: DatabaseSync,
  input: { event: string; message: string; since: string; now: string },
): boolean {
  const result = sqlite
    .prepare(
      `UPDATE server_log SET count = count + 1, last_at = ?
       WHERE id = (
         SELECT id FROM server_log
         WHERE event = ? AND message = ? AND last_at >= ?
         ORDER BY last_at DESC LIMIT 1
       )`,
    )
    .run(input.now, input.event, input.message, input.since);
  return Number(result.changes) > 0;
}

/**
 * Newest first, by `last_at`. Paging backwards takes the timestamp and id of the
 * oldest entry already held; the id breaks ties within a millisecond and points
 * back at insertion order, as the audit log does. An optional level narrows the
 * page to one severity.
 */
export function listServerLog(
  sqlite: DatabaseSync,
  options: { limit: number; before?: string; beforeId?: string; level?: string },
): ServerLogRow[] {
  const { limit, before, beforeId, level } = options;
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (before && beforeId) {
    clauses.push('(last_at < ? OR (last_at = ? AND rowid < (SELECT rowid FROM server_log WHERE id = ?)))');
    params.push(before, before, beforeId);
  } else if (before) {
    clauses.push('last_at < ?');
    params.push(before);
  }
  if (level) {
    clauses.push('level = ?');
    params.push(level);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = sqlite
    .prepare(`SELECT * FROM server_log ${where} ORDER BY last_at DESC, rowid DESC LIMIT ?`)
    .all(...params);
  return rows as unknown as ServerLogRow[];
}

/** Removes entries last written before `before`, returning how many went. */
export function deleteServerLogOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite.prepare('DELETE FROM server_log WHERE last_at < ?').run(before);
  return Number(result.changes);
}

/** Empties the log, returning how many entries were removed. */
export function clearServerLog(sqlite: DatabaseSync): number {
  const result = sqlite.prepare('DELETE FROM server_log').run();
  return Number(result.changes);
}
