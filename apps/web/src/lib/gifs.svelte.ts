import type { Attachment, GifFavorite, GifFavoriteListResponse, GifItem, GifListResponse } from '@harmony/shared';
import { api } from './api';

/**
 * The picker's data. Both tabs are kept here so a heart pressed on one is
 * reflected on the other: a gif saved from the local list shows as saved when the
 * favourites list is next opened, without a refetch.
 */
class GifState {
  favorites = $state<GifFavorite[]>([]);
  local = $state<GifItem[]>([]);
  /** Raised with each local search, so a slower earlier one cannot overwrite it. */
  #search = 0;

  async loadFavorites(): Promise<void> {
    try {
      this.favorites = (await api<GifFavoriteListResponse>('/gifs/favorites')).favorites;
    } catch {
      // Not signed in or offline — leave the list empty.
    }
  }

  async searchLocal(query: string): Promise<void> {
    const search = ++this.#search;
    try {
      const params = new URLSearchParams();
      if (query.trim().length > 0) params.set('q', query.trim());
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const body = await api<GifListResponse>(`/gifs/local${suffix}`);
      if (search !== this.#search) return;
      this.local = body.gifs;
    } catch {
      // Leave whatever was there.
    }
  }

  /** Keeps a gif, and marks it wherever it is already on show. */
  async save(attachmentId: string): Promise<void> {
    const favorite = await api<GifFavorite>('/gifs/favorites', {
      method: 'POST',
      body: JSON.stringify({ attachmentId }),
    });
    this.favorites = [favorite, ...this.favorites.filter((entry) => entry.id !== favorite.id)];
    this.local = this.local.map((item) =>
      item.hash === favorite.hash ? { ...item, favoriteId: favorite.id } : item,
    );
  }

  async forget(favoriteId: string): Promise<void> {
    await api(`/gifs/favorites/${favoriteId}`, { method: 'DELETE' });
    this.favorites = this.favorites.filter((entry) => entry.id !== favoriteId);
    this.local = this.local.map((item) => (item.favoriteId === favoriteId ? { ...item, favoriteId: null } : item));
  }

  /** Takes a gif into the message being written; returns the pending attachment. */
  pick(ref: { attachmentId: string } | { favoriteId: string }): Promise<Attachment> {
    return api<Attachment>('/gifs/pick', { method: 'POST', body: JSON.stringify(ref) });
  }
}

export const gifs = new GifState();

/** Where the picker loads each kind of gif from. */
export function favoriteUrl(favorite: GifFavorite): string {
  return `/api/v1/gifs/favorites/${favorite.id}/image`;
}

export function localUrl(item: GifItem): string {
  return `/api/v1/attachments/${item.id}`;
}
