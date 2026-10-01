import type { InstanceMeta } from '@harmony/shared';
import { api } from './api';
import { setSavedTheme } from './theme';

/** Points the browser tab icon at the instance icon. */
function applyFavicon(url: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.type = 'image/png';
  link.href = url;
}

/** Public instance metadata, loaded once so the shell can show the server name. */
class MetaState {
  data = $state<InstanceMeta | null>(null);

  get serverName(): string {
    return this.data?.name ?? 'Harmony';
  }

  get requireInvite(): boolean {
    return this.data?.requireInvite ?? false;
  }

  /**
   * The instance icon: the uploaded one when there is one, otherwise the default
   * bundled with the web client. The hash goes in the query so a replaced icon
   * is a new URL and never comes from the cache.
   */
  get iconUrl(): string {
    const hash = this.data?.iconHash;
    return hash ? `/api/v1/icon?v=${hash}` : '/icon.png';
  }

  async load(): Promise<void> {
    try {
      this.data = await api<InstanceMeta>('/meta');
      // Theme the shell before anything renders, so even sign-in is colored.
      setSavedTheme(this.data.theme);
      applyFavicon(this.iconUrl);
    } catch {
      // Keep the built-in defaults if the server is unreachable.
    }
  }

  /** Records an admin's upload or reset, and updates the tab icon to match. */
  setIconHash(hash: string | null): void {
    if (this.data) this.data = { ...this.data, iconHash: hash };
    applyFavicon(this.iconUrl);
  }
}

export const meta = new MetaState();
