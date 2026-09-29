import { deriveTheme, type ThemeSettings, type ThemeTokens } from '@harmony/shared';

/** The theme last loaded from the server or saved by an admin. */
let saved: Partial<ThemeSettings> = {};

function apply(tokens: ThemeTokens): void {
  const root = document.documentElement;
  root.style.setProperty('--h-bg', tokens.bg);
  root.style.setProperty('--h-bg-elevated', tokens.bgElevated);
  root.style.setProperty('--h-bg-deep', tokens.bgDeep);
  root.style.setProperty('--h-text', tokens.text);
  root.style.setProperty('--h-text-muted', tokens.textMuted);
  root.style.setProperty('--h-accent', tokens.accent);
  root.style.setProperty('--h-on-accent', tokens.onAccent);
  root.style.setProperty('--h-hover', tokens.hover);
  root.style.setProperty('--h-active', tokens.active);
  root.style.colorScheme = tokens.scheme;
}

/** Applies a theme and remembers it as the one to fall back to. */
export function setSavedTheme(theme: Partial<ThemeSettings> | null | undefined): void {
  saved = theme ?? {};
  apply(deriveTheme(saved));
}

/** Applies a theme temporarily, e.g. while an admin is picking colours. */
export function previewTheme(theme: Partial<ThemeSettings> | null | undefined): void {
  apply(deriveTheme(theme));
}

/** Re-applies the last saved theme, discarding any preview. */
export function restoreTheme(): void {
  apply(deriveTheme(saved));
}
