import { deriveTheme, type ThemeSettings, type ThemeTokens } from '@harmony/shared';

/** The theme last loaded from the server or saved by an admin. */
let saved: Partial<ThemeSettings> = {};

function apply(tokens: ThemeTokens): void {
  const root = document.documentElement;
  root.style.setProperty('--h-bg', tokens.bg);
  root.style.setProperty('--h-bg-elevated', tokens.bgElevated);
  root.style.setProperty('--h-bg-deep', tokens.bgDeep);
  root.style.setProperty('--h-bg-raised', tokens.bgRaised);
  root.style.setProperty('--h-bg-overlay', tokens.bgOverlay);
  root.style.setProperty('--h-text', tokens.text);
  root.style.setProperty('--h-text-muted', tokens.textMuted);
  root.style.setProperty('--h-text-faint', tokens.textFaint);
  root.style.setProperty('--h-accent', tokens.accent);
  root.style.setProperty('--h-accent-hover', tokens.accentHover);
  root.style.setProperty('--h-accent-subtle', tokens.accentSubtle);
  root.style.setProperty('--h-accent-glow', tokens.accentGlow);
  root.style.setProperty('--h-accent-gradient', tokens.accentGradient);
  root.style.setProperty('--h-on-accent', tokens.onAccent);
  root.style.setProperty('--h-hover', tokens.hover);
  root.style.setProperty('--h-active', tokens.active);
  root.style.setProperty('--h-border', tokens.border);
  root.style.setProperty('--h-border-strong', tokens.borderStrong);
  root.style.setProperty('--h-glass-bg', tokens.glassBg);
  root.style.setProperty('--h-glass-border', tokens.glassBorder);
  root.style.colorScheme = tokens.scheme;
  // The Android status bar and splash screen follow the app's own colors.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.bg);
}

/** Applies a theme and remembers it as the one to fall back to. */
export function setSavedTheme(theme: Partial<ThemeSettings> | null | undefined): void {
  saved = theme ?? {};
  apply(deriveTheme(saved));
}

/** Applies a theme temporarily, e.g. while an admin is picking colors. */
export function previewTheme(theme: Partial<ThemeSettings> | null | undefined): void {
  apply(deriveTheme(theme));
}

/** Re-applies the last saved theme, discarding any preview. */
export function restoreTheme(): void {
  apply(deriveTheme(saved));
}
