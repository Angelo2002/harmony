/**
 * Channel slowmode: a per-member cooldown between messages, the same idea as
 * Discord's. It lives in `shared` so the server enforces exactly what the admin
 * panel offers and the composer explains.
 */

/** The longest slowmode the API accepts: six hours, Discord's maximum. */
export const MAX_SLOWMODE_SECONDS = 21_600;

/** A short human label, e.g. `30s`, `5m`, `2h`. */
export function formatSlowmode(seconds: number): string {
  if (seconds <= 0) return 'off';
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The values the admin picker offers, mirroring Discord's list. */
const SLOWMODE_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 3600, 7200, 21_600];

export const SLOWMODE_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'Slowmode off' },
  ...SLOWMODE_STEPS.map((seconds) => ({ seconds, label: formatSlowmode(seconds) })),
];
