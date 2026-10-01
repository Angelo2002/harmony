/**
 * Per-instance theming.
 *
 * An admin picks just two colors: a background and an accent. Everything else
 * the client needs — the panel surfaces, the text grays, the translucent hover
 * and active overlays, and the color placed on top of accent surfaces — is
 * derived here, so both dark and light backgrounds come out readable without
 * anyone having to reason about contrast.
 */

/** The two colors an admin picks. `null` means "keep the built-in default". */
export interface ThemeSettings {
  background: string | null;
  accent: string | null;
}

/** Every color the client turns into a CSS custom property. */
export interface ThemeTokens {
  /** Whether the derived palette is dark or light, for `color-scheme`. */
  scheme: 'dark' | 'light';
  bg: string;
  bgElevated: string;
  bgDeep: string;
  text: string;
  textMuted: string;
  accent: string;
  /** Text and icons placed on top of an accent-colored surface. */
  onAccent: string;
  /** Translucent overlays for hover and selected states. */
  hover: string;
  active: string;
}

/** Matches a `#rrggbb` color, the only form the theme accepts. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_BACKGROUND = '#313338';
export const DEFAULT_ACCENT = '#5865f2';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Below this luminance a background is treated as light rather than dark. */
const LIGHT_THRESHOLD = 0.45;
/** Above this luminance an accent takes dark text on top of it. */
const ON_ACCENT_THRESHOLD = 0.6;
/** Backgrounds darker than this have no room to darken further. */
const NEAR_BLACK = 0.004;

function parseHex(value: string | null | undefined): Rgb | null {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function toHex(color: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** Perceived brightness, 0 for black and 1 for white. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

/**
 * Derives the whole palette from the two colors an admin picks. Anything left
 * null falls back to the built-in defaults, so an untouched instance renders
 * exactly as it always did.
 */
export function deriveTheme(settings: Partial<ThemeSettings> | null | undefined): ThemeTokens {
  const bg = parseHex(settings?.background) ?? (parseHex(DEFAULT_BACKGROUND) as Rgb);
  const accent = parseHex(settings?.accent) ?? (parseHex(DEFAULT_ACCENT) as Rgb);

  const luminance = relativeLuminance(toHex(bg));
  const light = luminance > LIGHT_THRESHOLD;

  // Panels sit darker than the main surface in both themes, except for a
  // background that is already essentially black, where stepping up is the only
  // way to keep them apart.
  const nearBlack = luminance < NEAR_BLACK;
  const stepToward = nearBlack ? WHITE : BLACK;
  const elevatedAmount = nearBlack ? 0.07 : light ? 0.04 : 0.12;
  const deepAmount = nearBlack ? 0.14 : light ? 0.11 : 0.38;

  const toward = light ? BLACK : WHITE;

  return {
    scheme: light ? 'light' : 'dark',
    bg: toHex(bg),
    bgElevated: toHex(mix(bg, stepToward, elevatedAmount)),
    bgDeep: toHex(mix(bg, stepToward, deepAmount)),
    text: toHex(mix(bg, toward, light ? 0.88 : 0.87)),
    textMuted: toHex(mix(bg, toward, 0.55)),
    accent: toHex(accent),
    onAccent: relativeLuminance(toHex(accent)) > ON_ACCENT_THRESHOLD ? '#000000' : '#ffffff',
    hover: light ? 'rgb(0 0 0 / 5%)' : 'rgb(255 255 255 / 4%)',
    active: light ? 'rgb(0 0 0 / 9%)' : 'rgb(255 255 255 / 8%)',
  };
}
