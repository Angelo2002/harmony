/** Turns a permission key like `ManageMessages` into `Manage Messages`. */
export function permissionLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Formats an RGB integer as a CSS color. */
export function roleColor(color: number | null): string {
  return color == null ? 'var(--h-text-muted)' : `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * The glyph shown before a channel name: a link for channels bridged to Discord,
 * a hash for everything else.
 */
export function channelGlyph(channel: { discordChannelId: string | null }): string {
  return channel.discordChannelId ? '🔗' : '#';
}

/** Human-readable byte size, e.g. `1.5 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
