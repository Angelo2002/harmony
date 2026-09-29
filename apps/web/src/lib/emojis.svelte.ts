import type { Emoji, EmojiListResponse } from '@harmony/shared';
import { api } from './api';

/** Custom emoji available on this instance. */
class EmojiState {
  list = $state<Emoji[]>([]);

  /** Name -> emoji lookup, rebuilt whenever the list changes. */
  lookup = $derived(new Map(this.list.map((emoji) => [emoji.name, emoji])));

  async load(): Promise<void> {
    try {
      this.list = (await api<EmojiListResponse>('/emojis')).emojis;
    } catch {
      // Not signed in or offline — leave the list empty.
    }
  }
}

export const emojis = new EmojiState();
