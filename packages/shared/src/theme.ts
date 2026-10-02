/**
 * Per-instance theming.
 *
 * An admin picks just two colors: a background and an accent. Everything else
 * the client needs — the surface elevation ladder, the text grays, the borders,
 * the translucent washes and glows built from the accent, and the color placed
 * on top of accent surfaces — is derived here, so both dark and light
 * backgrounds come out readable without anyone having to reason about contrast.
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
  /** A step above the panels, for chips and raised rows. */
  bgRaised: string;
  /** The topmost surface, for scrollbar thumbs and hovered raised elements. */
  bgOverlay: string;
  text: string;
  textMuted: string;
  /** Dimmer than muted, for timestamps and hints. */
  textFaint: string;
  accent: string;
  /** The accent for a hovered accent-colored control. */
  accentHover: string;
  /** The accent as a faint wash, for selected rows and mention chips. */
  accentSubtle: string;
  /** The accent as a soft glow, for the ring around an accent surface. */
  accentGlow: string;
  /** The accent flowing into a close hue, for surfaces that deserve flourish. */
  accentGradient: string;
  /** Text and icons placed on top of an accent-colored surface. */
  onAccent: string;
  /** Translucent overlays for hover and selected states. */
  hover: string;
  active: string;
  /** A hairline separator between surfaces. */
  border: string;
  /** A separator that should read more firmly, e.g. on hover. */
  borderStrong: string;
  /** A translucent surface for floating layers: dialogs, cards, menus. */
  glassBg: string;
  glassBorder: string;
}

/** Matches a `#rrggbb` color, the only form the theme accepts. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * The built-in dark palette. A deliberately deep, near-black background: it is
 * what the surface ladder and the hairlines are tuned for, and an admin who
 * wants something else can pick it in one step.
 */
export const DEFAULT_BACKGROUND = '#12151a';
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

/** `rgb(r g b / p%)`, the form the client's translucent tokens take. */
function withAlpha(color: Rgb, percent: number): string {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  return `rgb(${clamp(color.r)} ${clamp(color.g)} ${clamp(color.b)} / ${percent}%)`;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: h / 6, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
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
  const nearBlack = luminance < NEAR_BLACK;

  // Elevation steps toward the text color: surfaces get lighter on a dark
  // background and darker on a light one, so a panel reads as raised either way.
  const elevateToward = light ? BLACK : WHITE;
  // Recessed surfaces step the other way. A near-black background has no room to
  // darken at all, so its recessed steps climb instead of sinking.
  const recessToward = nearBlack ? WHITE : BLACK;
  const textToward = light ? BLACK : WHITE;

  // A near-black background needs larger steps to show any separation at all.
  const steps = nearBlack
    ? { elevated: 0.07, raised: 0.12, overlay: 0.18, deep: 0.03 }
    : light
      ? { elevated: 0.045, raised: 0.085, overlay: 0.125, deep: 0.16 }
      : { elevated: 0.05, raised: 0.1, overlay: 0.15, deep: 0.3 };

  const elevated = mix(bg, elevateToward, steps.elevated);
  const accentHover = mix(accent, light ? BLACK : WHITE, 0.12);
  // A close hue, a touch lighter, so a gradient reads as depth rather than a
  // second color someone has to keep in step with the accent.
  const accentHsl = toHsl(accent);
  const gradientEnd = fromHsl({
    h: (accentHsl.h + 0.05) % 1,
    s: accentHsl.s,
    l: Math.min(1, accentHsl.l + 0.05),
  });

  const border = light ? 'rgb(0 0 0 / 11%)' : 'rgb(255 255 255 / 8%)';
  const borderStrong = light ? 'rgb(0 0 0 / 18%)' : 'rgb(255 255 255 / 14%)';

  return {
    scheme: light ? 'light' : 'dark',
    bg: toHex(bg),
    bgElevated: toHex(elevated),
    bgDeep: toHex(mix(bg, recessToward, steps.deep)),
    bgRaised: toHex(mix(bg, elevateToward, steps.raised)),
    bgOverlay: toHex(mix(bg, elevateToward, steps.overlay)),
    text: toHex(mix(bg, textToward, light ? 0.88 : 0.87)),
    textMuted: toHex(mix(bg, textToward, 0.55)),
    textFaint: toHex(mix(bg, textToward, 0.38)),
    accent: toHex(accent),
    accentHover: toHex(accentHover),
    accentSubtle: withAlpha(accent, 12),
    accentGlow: withAlpha(accent, 38),
    accentGradient: `linear-gradient(135deg, ${toHex(accent)} 0%, ${toHex(gradientEnd)} 100%)`,
    onAccent: relativeLuminance(toHex(accent)) > ON_ACCENT_THRESHOLD ? '#000000' : '#ffffff',
    hover: light ? 'rgb(0 0 0 / 5%)' : 'rgb(255 255 255 / 4%)',
    active: light ? 'rgb(0 0 0 / 9%)' : 'rgb(255 255 255 / 8%)',
    border,
    borderStrong,
    glassBg: withAlpha(elevated, 78),
    glassBorder: border,
  };
}
