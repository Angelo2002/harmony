<script lang="ts">
  import { onMount } from 'svelte';
  import type { Mention, MentionListResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const pageSize = 25;

  let inbox = $state<Mention[]>([]);
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  const hasMore = $derived(inbox.length >= pageSize);
  const unreadCount = $derived(inbox.filter((mention) => mention.unread).length);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function channelName(channelId: string): string {
    return chat.channels.find((channel) => channel.id === channelId)?.name ?? 'a channel';
  }

  function authorName(mention: Mention): string {
    return mention.message.author?.displayName ?? mention.message.author?.username ?? 'Deleted user';
  }

  /** Not every mention carries text: a reply or a mention can be an image alone. */
  function preview(mention: Mention): string {
    if (mention.message.content.length > 0) return mention.message.content;
    return mention.message.attachments.length > 0 ? '(attachment)' : '';
  }

  function buildQuery(before?: Mention): string {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (before) {
      query.set('before', before.message.createdAt);
      query.set('beforeId', before.message.id);
    }
    return query.toString();
  }

  async function load(): Promise<void> {
    busy = true;
    error = null;
    try {
      inbox = (await api<MentionListResponse>(`/mentions?${buildQuery()}`)).mentions;
      loaded = true;
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Loads the page of mentions older than the oldest one already shown. */
  async function loadMore(): Promise<void> {
    const oldest = inbox[inbox.length - 1];
    if (!oldest) return;

    busy = true;
    error = null;
    try {
      const page = await api<MentionListResponse>(`/mentions?${buildQuery(oldest)}`);
      inbox = [...inbox, ...page.mentions];
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function open(mention: Mention): Promise<void> {
    await chat.jumpToMessage(mention.message.channelId, mention.message);
    onclose();
  }

  onMount(() => {
    void load();
  });
</script>

<div class="admin-overlay">
  <div class="admin inbox-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Mentions</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if busy && inbox.length === 0}
        <p class="muted">Loading…</p>
      {:else if loaded && inbox.length === 0}
        <p class="muted">
          Nothing here yet. Messages that mention you, or reply to you, will show up here.
        </p>
      {:else}
        {#if unreadCount > 0}
          <p class="muted">{unreadCount} unread.</p>
        {/if}
        <ul class="search-results">
          {#each inbox as mention (mention.message.id)}
            <li>
              <button
                type="button"
                class="search-result"
                class:unread={mention.unread}
                onclick={() => open(mention)}
              >
                <span class="search-result-head">
                  {#if avatarUrl(mention.message.author)}
                    <img class="avatar small" src={avatarUrl(mention.message.author)} alt="" loading="lazy" />
                  {:else}
                    <span class="avatar small fallback">{initial(mention.message.author)}</span>
                  {/if}
                  <strong>{authorName(mention)}</strong>
                  <span class="muted">
                    {mention.kind === 'reply' ? 'replied to you' : 'mentioned you'} in #{channelName(mention.message.channelId)}
                  </span>
                  <time class="muted">{new Date(mention.message.createdAt).toLocaleString()}</time>
                </span>
                <span class="search-result-text">{preview(mention)}</span>
              </button>
            </li>
          {/each}
        </ul>

        {#if hasMore}
          <div class="editor-actions">
            <button type="button" onclick={loadMore} disabled={busy}>
              {busy ? 'Loading…' : 'Load older mentions'}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
