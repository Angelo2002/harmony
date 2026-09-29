import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { DEFAULT_MAX_UPLOAD_BYTES } from '@harmony/shared';

export interface Config {
  host: string;
  port: number;
  /** Directory holding the SQLite database and uploaded files. */
  dataDir: string;
  dbFile: string;
  /** Directory holding content-addressed uploaded blobs. */
  uploadDir: string;
  /** Largest accepted upload, in bytes. */
  maxUploadBytes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** When true, registration demands a valid invite code (the first user is always exempt). */
  requireInvite: boolean;
  /** Lifetime of a login session, in days. */
  sessionTtlDays: number;
  cookieName: string;
  /** Set true when serving over HTTPS so the session cookie is marked `Secure`. */
  cookieSecure: boolean;
  /** Enable when running behind a reverse proxy so client IPs are read from `X-Forwarded-For`. */
  trustProxy: boolean;
}

// Load `.env` if present, without pulling in a dotenv dependency.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

// Default to a `data/` directory at the repository root, so the database is
// the same no matter which directory the server is started from.
const defaultDataDir = resolve(import.meta.dirname, '..', '..', '..', 'data');

export function loadConfig(): Config {
  const dataDir = process.env.HARMONY_DATA_DIR
    ? resolve(process.cwd(), process.env.HARMONY_DATA_DIR)
    : defaultDataDir;
  return {
    host: process.env.HARMONY_HOST ?? '127.0.0.1',
    port: readNumber(process.env.HARMONY_PORT, 8787),
    dataDir,
    dbFile: resolve(dataDir, 'harmony.db'),
    uploadDir: resolve(dataDir, 'uploads'),
    maxUploadBytes: Math.floor(
      readNumber(process.env.HARMONY_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_BYTES / (1024 * 1024)) * 1024 * 1024,
    ),
    logLevel: (process.env.HARMONY_LOG_LEVEL as Config['logLevel']) ?? 'info',
    requireInvite: readBoolean(process.env.HARMONY_REQUIRE_INVITE, false),
    sessionTtlDays: readNumber(process.env.HARMONY_SESSION_TTL_DAYS, 30),
    cookieName: process.env.HARMONY_COOKIE_NAME ?? 'harmony_session',
    cookieSecure: readBoolean(process.env.HARMONY_COOKIE_SECURE, false),
    trustProxy: readBoolean(process.env.HARMONY_TRUST_PROXY, false),
  };
}
