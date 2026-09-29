/** Turns a permission key like `ManageMessages` into `Manage Messages`. */
export function permissionLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Formats an RGB integer as a CSS colour. */
export function roleColor(color: number | null): string {
  return color == null ? 'var(--h-text-muted)' : `#${color.toString(16).padStart(6, '0')}`;
}
