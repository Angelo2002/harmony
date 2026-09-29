import type { InstanceMeta } from '@harmony/shared';
import { api } from './api';
import { setSavedTheme } from './theme';

/** Public instance metadata, loaded once so the shell can show the server name. */
class MetaState {
  data = $state<InstanceMeta | null>(null);

  get serverName(): string {
    return this.data?.name ?? 'Harmony';
  }

  get requireInvite(): boolean {
    return this.data?.requireInvite ?? false;
  }

  async load(): Promise<void> {
    try {
      this.data = await api<InstanceMeta>('/meta');
      // Theme the shell before anything renders, so even sign-in is coloured.
      setSavedTheme(this.data.theme);
    } catch {
      // Keep the built-in defaults if the server is unreachable.
    }
  }
}

export const meta = new MetaState();
