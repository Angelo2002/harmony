/**
 * Scrubs a server-log message or its structured detail before any of it is
 * stored, so a token pasted into an error string cannot end up readable in the
 * table. It is deliberately blunt — a false redaction costs a little context, a
 * missed one costs a credential — and it is exported so the rules can be tested
 * directly.
 */

/** A message is capped at this many characters. */
export const MAX_LOG_MESSAGE_LENGTH = 500;

/** A sanitized detail is capped at roughly this many bytes of JSON. */
export const MAX_LOG_DETAIL_LENGTH = 2048;

/** How deep into nested detail objects the scrubber follows before giving up. */
const MAX_DETAIL_DEPTH = 4;

const REDACTED = '[redacted]';

/**
 * The word for a secret, then `: value` or `= value`. `authorization` and
 * `bearer` also swallow the `Bearer ` scheme in front of the value, so an
 * `Authorization: Bearer <token>` header is redacted whole rather than down to
 * the word "Bearer".
 */
const SECRET_ASSIGNMENT =
  /\b(bearer|token|password|secret|authorization|api[_-]?key)\b(\s*[:=]\s*)((?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+))/gi;

/** A Discord bot token: three dot-separated base64url segments. */
const DISCORD_BOT_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/g;

/**
 * A detail key that names a secret, so its value is redacted whatever it holds.
 * Blunt on purpose: a value under `token` need not contain any marker to match on,
 * as `{ token: 'abc' }` does not, so the key alone has to condemn it.
 */
const SENSITIVE_KEY = /(bearer|token|password|secret|authorization|api[_-]?key|credential)/i;

/** Replaces every secret the patterns above can recognize with a marker. */
function redact(text: string): string {
  return text.replace(DISCORD_BOT_TOKEN, REDACTED).replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`);
}

/** Redacts secrets in a message and caps it at `MAX_LOG_MESSAGE_LENGTH` characters. */
export function sanitizeLogText(text: string): string {
  const redacted = redact(text);
  return redacted.length > MAX_LOG_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_LOG_MESSAGE_LENGTH - 1)}…` : redacted;
}

/** Redacts the strings inside a value, recursing into objects and arrays. */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redact(value);
  if (depth >= MAX_DETAIL_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A key that names a secret redacts its value outright; the value itself
      // may carry nothing to match on.
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redacts the strings in a detail object and keeps the result within
 * `MAX_LOG_DETAIL_LENGTH` of JSON. A detail too large to keep whole is replaced
 * by a truncated serialization of itself, so the entry is still there to read
 * rather than dropped at the door.
 */
export function sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(detail, 0) as Record<string, unknown>;
  const json = JSON.stringify(sanitized);
  if (json.length <= MAX_LOG_DETAIL_LENGTH) return sanitized;
  return { truncated: json.slice(0, MAX_LOG_DETAIL_LENGTH - 20) };
}
