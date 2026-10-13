/**
 * The rules behind the per-member playback volume: what a volume is allowed to
 * be and how the map kept in browser storage is read and written.
 *
 * Kept in a plain module, away from the rune store that owns the audio graph and
 * localStorage, so the parsing and clamping can be checked without a browser.
 * The value is a gain multiplier on one incoming track: 0 is silence, 1 is the
 * member's own level and 2 is twice as loud.
 */

/** The loudest a single member can be turned up to, as a playback multiplier. */
export const VOICE_VOLUME_MAX = 2;
/** What a member nobody has adjusted plays at. */
export const VOICE_VOLUME_DEFAULT = 1;

/** Keeps a requested gain inside the allowed range; a non-number falls back to the default. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return VOICE_VOLUME_DEFAULT;
  return Math.min(VOICE_VOLUME_MAX, Math.max(0, value));
}

/**
 * Reads a stored volume map. Malformed JSON, the wrong shape, or entries that
 * are not numbers all read as nothing stored; a number outside the range is
 * clamped, so a hand-edited or older value can never push the gain past its
 * bounds.
 */
export function parseVolumes(raw: string | null): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const volumes: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number') volumes[id] = clampVolume(value);
  }
  return volumes;
}

/**
 * The override stored for one member, or undefined when this map does not carry
 * one. The lookup is by own key: a member id that happens to name an
 * `Object.prototype` property (`constructor`, `toString`, `valueOf`, `__proto__`,
 * ...) must read as no override rather than inheriting the prototype's value, so
 * a stray id can never leak a non-number into a gain or look like an adjustment.
 */
export function volumeOverride(volumes: Record<string, number>, userId: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(volumes, userId)) return undefined;
  return volumes[userId];
}

/**
 * Renders the volume map for storage. A member left at the default is dropped,
 * so only real overrides are written, and a map with no overrides serializes to
 * null, meaning the caller should remove the key rather than store an empty one.
 */
export function serializeVolumes(volumes: Record<string, number>): string | null {
  const overrides: Record<string, number> = {};
  for (const [id, value] of Object.entries(volumes)) {
    const clamped = clampVolume(value);
    if (clamped !== VOICE_VOLUME_DEFAULT) overrides[id] = clamped;
  }
  return Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides);
}
