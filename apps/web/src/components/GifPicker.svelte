<script lang="ts">
  import { onMount } from 'svelte';
  import type { Attachment, GifFavorite, GifItem } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { favoriteUrl, gifs, localUrl } from '../lib/gifs.svelte';

  let { onpick }: { onpick: (attachment: Attachment) => void } = $props();

  /** How long typing settles before the local list is asked for. */
  const SEARCH_DEBOUNCE_MS = 250;

  type Tab = 'favorites' | 'local';
  /** The gifs somebody kept come first, the way they do in Discord. */
  let tab = $state<Tab>('favorites');
  let query = $state('');
  let error = $state<string | null>(null);
  /** The tile whose pick or heart is in flight, if any. */
  let busy = $state<string | null>(null);

  interface Tile {
    key: string;
    url: string;
    label: string;
    favoriteId: string | null;
    ref: { attachmentId: string } | { favoriteId: string };
  }

  function favoriteTile(favorite: GifFavorite): Tile {
    return {
      key: `f-${favorite.id}`,
      url: favoriteUrl(favorite),
      label: favorite.filename,
      favoriteId: favorite.id,
      ref: { favoriteId: favorite.id },
    };
  }

  function localTile(item: GifItem): Tile {
    return {
      key: `l-${item.id}`,
      url: localUrl(item),
      label: item.filename,
      favoriteId: item.favoriteId,
      ref: { attachmentId: item.id },
    };
  }

  const tiles = $derived(tab === 'favorites' ? gifs.favorites.map(favoriteTile) : gifs.local.map(localTile));
  const searching = $derived(query.trim().length > 0);
  const emptyMessage = $derived(
    tab === 'favorites'
      ? searching
        ? 'No saved gif matches that.'
        : 'Nothing saved yet. Press the heart on a gif to keep it.'
      : searching
        ? 'No gif here matches that.'
        : 'Nothing here yet. Gifs posted in channels you can see turn up here.',
  );

  onMount(() => {
    void gifs.loadFavorites();
  });

  // Waits for typing to settle before asking, since a search is a round trip. Runs
  // once on open too, which is what fills the local tab the first time.
  $effect(() => {
    const settled = query;
    const timer = setTimeout(() => void gifs.searchLocal(settled), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function pick(tile: Tile): Promise<void> {
    busy = tile.key;
    error = null;
    try {
      onpick(await gifs.pick(tile.ref));
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  async function toggleFavorite(tile: Tile): Promise<void> {
    // Only a gif this instance already holds can be kept, which is why the heart
    // is the one thing on a tile that can decline to act.
    if (tile.favoriteId === null && !('attachmentId' in tile.ref)) return;
    busy = tile.key;
    error = null;
    try {
      if (tile.favoriteId !== null) await gifs.forget(tile.favoriteId);
      else if ('attachmentId' in tile.ref) await gifs.save(tile.ref.attachmentId);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }
</script>

<div class="gif-picker">
  <div class="emoji-picker-head">
    <input
      class="emoji-search"
      type="search"
      bind:value={query}
      placeholder="Search gifs"
      aria-label="Search gifs"
      autocomplete="off"
    />
    <div class="emoji-tabs">
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'favorites'}
        aria-pressed={tab === 'favorites'}
        onclick={() => (tab = 'favorites')}
      >
        Favourites
      </button>
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'local'}
        aria-pressed={tab === 'local'}
        onclick={() => (tab = 'local')}
      >
        This server
      </button>
    </div>
  </div>

  <div class="gif-body">
    {#if error}<p class="form-error">{error}</p>{/if}

    {#if tiles.length === 0}
      <p class="muted emoji-empty">{emptyMessage}</p>
    {:else}
      <div class="gif-grid">
        {#each tiles as tile (tile.key)}
          <div class="gif-tile">
            <button
              type="button"
              class="gif-send"
              title="Send this gif"
              disabled={busy === tile.key}
              onclick={() => pick(tile)}
            >
              <img src={tile.url} alt={tile.label} loading="lazy" />
            </button>
            <button
              type="button"
              class="gif-heart"
              class:on={tile.favoriteId !== null}
              aria-pressed={tile.favoriteId !== null}
              title={tile.favoriteId !== null ? 'Remove from favourites' : 'Add to favourites'}
              disabled={busy === tile.key}
              onclick={() => toggleFavorite(tile)}
            >
              {tile.favoriteId !== null ? '♥' : '♡'}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
