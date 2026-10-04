import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerLogEntry, ServerLogLevel, ServerLogListResponse, ServerLogQuery } from '@harmony/shared';
import {
  clearServerLog,
  coalesceServerLog,
  deleteServerLogOlderThan,
  insertServerLog,
  listServerLog,
  type ServerLogRow,
} from '../db/server_log.ts';
import { sanitizeDetail, sanitizeLogText } from './sanitize.ts';

/**
 * A repeated warning or error within this window folds onto the row it repeats
 * rather than piling up. Informational events never coalesce: each is a distinct
 * thing that happened.
 */
const COALESCE_WINDOW_MS = 5 * 60 * 1000;

export interface ServerLogService {
  info(event: string, message: string, detail?: Record<string, unknown>): void;
  warn(event: string, message: string, detail?: Record<string, unknown>): void;
  error(event: string, message: string, detail?: Record<string, unknown>): void;
  list(query: ServerLogQuery): ServerLogListResponse;
  /** Empties the log, returning how many entries were removed. */
  clear(): number;
  pruneOlderThan(before: string): number;
}

/**
 * The instance's own log: what the server did, and where it failed. Everything
 * written here is sanitized first, and a repeated warning or error is coalesced
 * onto one row, so the table stays small and free of secrets. Reading it is
 * owner-only; see routes/server-log.ts.
 */
export function createServerLogService(sqlite: DatabaseSync): ServerLogService {
  function write(
    level: ServerLogLevel,
    event: string,
    message: string,
    detail: Record<string, unknown> | undefined,
    coalesce: boolean,
  ): void {
    const safeMessage = sanitizeLogText(message);
    const now = new Date().toISOString();

    if (coalesce) {
      const since = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
      if (coalesceServerLog(sqlite, { event, message: safeMessage, since, now })) return;
    }

    insertServerLog(sqlite, {
      id: randomUUID(),
      level,
      event,
      message: safeMessage,
      detail: JSON.stringify(sanitizeDetail(detail ?? {})),
      firstAt: now,
      lastAt: now,
    });
  }

  function parseDetail(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  function toEntry(row: ServerLogRow): ServerLogEntry {
    return {
      id: row.id,
      level: row.level as ServerLogLevel,
      event: row.event,
      message: row.message,
      detail: parseDetail(row.detail),
      count: row.count,
      firstAt: row.first_at,
      lastAt: row.last_at,
    };
  }

  return {
    info(event, message, detail) {
      write('info', event, message, detail, false);
    },

    warn(event, message, detail) {
      write('warn', event, message, detail, true);
    },

    error(event, message, detail) {
      write('error', event, message, detail, true);
    },

    list(query) {
      const rows = listServerLog(sqlite, {
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
        level: query.level,
      });
      return { entries: rows.map(toEntry) };
    },

    clear() {
      return clearServerLog(sqlite);
    },

    pruneOlderThan(before) {
      return deleteServerLogOlderThan(sqlite, before);
    },
  };
}
