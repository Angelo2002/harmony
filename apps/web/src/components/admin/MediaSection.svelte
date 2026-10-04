<script lang="ts">
  import { onMount } from 'svelte';
  import type { MediaItem, MediaListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { formatBytes } from '../../lib/format';
  import { lightbox } from '../../lib/lightbox.svelte';

  const pageSize = 50;

  let media = $state<MediaItem[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let loading = $state(false);
  let reachedEnd = $state(false);

  async function load(): Promise<void> {
    loading = true;
    try {
      media = (await api<MediaListResponse>(`/media?limit=${pageSize}`)).media;
      reachedEnd = media.length < pageSize;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  async function loadMore(): Promise<void> {
    const oldest = media.at(-1)?.attachment;
    if (!oldest || loading) return;

    loading = true;
    error = null;
    try {
      const query = new URLSearchParams({
        limit: String(pageSize),
        before: oldest.createdAt,
        beforeId: oldest.id,
      });
      const page = (await api<MediaListResponse>(`/media?${query}`)).media;
      media = [...media, ...page];
      reachedEnd = page.length < pageSize;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  async function remove(item: MediaItem): Promise<void> {
    if (!confirm(`Delete ${item.attachment.filename}? This cannot be undone.`)) return;

    busy = true;
    error = null;
    try {
      await api(`/attachments/${item.attachment.id}`, { method: 'DELETE' });
      media = media.filter((entry) => entry.attachment.id !== item.attachment.id);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }
</script>

<section>
  <h3>Media</h3>
  <p class="muted">Every image and video stored on this instance, newest first. Deleting one frees its bytes.</p>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#if media.length === 0 && !loading}
    <p class="muted">No media stored yet.</p>
  {:else}
    <ul class="media-grid">
      {#each media as item (item.attachment.id)}
        <li class="media-card">
          {#if item.attachment.contentType.startsWith('video/')}
            <!-- Clips are stored as they arrive, with no caption track to offer. -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={`/api/v1/attachments/${item.attachment.id}`} controls preload="metadata"></video>
          {:else}
            <a
              href={`/api/v1/attachments/${item.attachment.id}`}
              target="_blank"
              rel="noreferrer"
              onclick={(event) => {
                event.preventDefault();
                lightbox.open(`/api/v1/attachments/${item.attachment.id}`, item.attachment.filename);
              }}
            >
              <img
                src={`/api/v1/attachments/${item.attachment.id}`}
                alt={item.attachment.filename}
                loading="lazy"
              />
            </a>
          {/if}
          <div class="media-meta">
            <span class="media-name" title={item.attachment.filename}>{item.attachment.filename}</span>
            <span class="muted">
              {formatBytes(item.attachment.size)}
              {#if item.uploader}· {item.uploader.displayName ?? item.uploader.username}{/if}
              {#if item.channelName}· #{item.channelName}{/if}
            </span>
            <span class="muted">{formatDate(item.attachment.createdAt)}</span>
          </div>
          <button type="button" class="danger" onclick={() => remove(item)} disabled={busy}>Delete</button>
        </li>
      {/each}
    </ul>

    {#if !reachedEnd}
      <div class="editor-actions">
        <button type="button" onclick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      </div>
    {/if}
  {/if}
</section>
