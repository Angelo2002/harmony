<script lang="ts">
  import type { Message, MessageListResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { members } from '../lib/members.svelte';

  let { onclose }: { onclose: () => void } = $props();

  /** How many matches a page holds, and how long typing settles before searching. */
  const pageSize = 25;
  const debounceMs = 300;

  let term = $state('');
  let channelFilter = $state('');
  let authorFilter = $state('');
  let results = $state<Message[]>([]);
  let searched = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);

  let debounce: ReturnType<typeof setTimeout> | null = null;

  const hasMore = $derived(results.length >= pageSize);
  const canSearch = $derived(term.trim().length > 0);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  /** Heading shown above a result, e.g. the channel it lives in. */
  function channelName(message: Message): string {
    return chat.channels.find((channel) => channel.id === message.channelId)?.name ?? 'a channel';
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Unknown';
  }

  /**
   * Splits a message into the parts a highlight should wrap, matching the search
   * term case-insensitively. Svelte escapes the text, so this is safe.
   */
  function highlightParts(content: string): Array<{ text: string; match: boolean }> {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) return [{ text: content, match: false }];

    const parts: Array<{ text: string; match: boolean }> = [];
    const haystack = content.toLowerCase();
    let cursor = 0;
    while (cursor < content.length) {
      const found = haystack.indexOf(needle, cursor);
      if (found === -1) break;
      if (found > cursor) parts.push({ text: content.slice(cursor, found), match: false });
      parts.push({ text: content.slice(found, found + needle.length), match: true });
      cursor = found + needle.length;
    }
    if (cursor < content.length) parts.push({ text: content.slice(cursor), match: false });
    return parts.length > 0 ? parts : [{ text: content, match: false }];
  }

  function buildQuery(before?: Message): string {
    const query = new URLSearchParams({ q: term.trim(), limit: String(pageSize) });
    if (channelFilter) query.set('channelId', channelFilter);
    if (authorFilter) query.set('authorId', authorFilter);
    if (before) {
      query.set('before', before.createdAt);
      query.set('beforeId', before.id);
    }
    return query.toString();
  }

  async function search(): Promise<void> {
    if (!canSearch) {
      results = [];
      searched = false;
      return;
    }

    busy = true;
    error = null;
    try {
      const data = await api<MessageListResponse>(`/search?${buildQuery()}`);
      results = data.messages;
      searched = true;
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Loads the page of matches older than the oldest one already shown. */
  async function loadMore(): Promise<void> {
    const oldest = results[results.length - 1];
    if (!oldest) return;

    busy = true;
    error = null;
    try {
      const data = await api<MessageListResponse>(`/search?${buildQuery(oldest)}`);
      results = [...results, ...data.messages];
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Restarts the settle timer, so a search runs once typing pauses. */
  function onInput(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void search();
    }, debounceMs);
  }

  /** Filters apply at once rather than waiting for more typing. */
  function onFilter(): void {
    if (debounce) clearTimeout(debounce);
    void search();
  }

  async function open(message: Message): Promise<void> {
    await chat.jumpToMessage(message.channelId, message);
    onclose();
  }

  $effect(() => {
    searchInput?.focus();
  });
</script>

<div class="admin-overlay">
  <div class="admin search-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Search messages</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      <form class="inline" onsubmit={(event) => { event.preventDefault(); onFilter(); }}>
        <input
          bind:this={searchInput}
          bind:value={term}
          oninput={onInput}
          placeholder="Search this server…"
          aria-label="Search messages"
          autocomplete="off"
        />
        <button type="submit" disabled={busy}>Search</button>
      </form>

      <div class="inline">
        <select bind:value={channelFilter} onchange={onFilter} title="Which channel to search">
          <option value="">All channels</option>
          {#each chat.channels as channel (channel.id)}
            <option value={channel.id}>#{channel.name}</option>
          {/each}
        </select>

        <select bind:value={authorFilter} onchange={onFilter} title="Who wrote it">
          <option value="">Anyone</option>
          {#each members.list as person (person.id)}
            <option value={person.id}>{person.displayName ?? person.username}</option>
          {/each}
        </select>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if !canSearch}
        <p class="muted">Type something to search for across every channel you can see.</p>
      {:else if busy && results.length === 0}
        <p class="muted">Searching…</p>
      {:else if !searched}
        <p class="muted">Press Enter to search.</p>
      {:else if results.length === 0}
        <p class="muted">No messages match “{term.trim()}”.</p>
      {:else}
        <p class="muted">
          {results.length}{#if hasMore}+{/if} match{results.length === 1 ? '' : 'es'}, newest first.
        </p>
        <ul class="search-results">
          {#each results as message (message.id)}
            <li>
              <button type="button" class="search-result" onclick={() => open(message)}>
                <span class="search-result-head">
                  {#if avatarUrl(message.author)}
                    <img class="avatar small" src={avatarUrl(message.author)} alt="" loading="lazy" />
                  {:else}
                    <span class="avatar small fallback">{initial(message.author)}</span>
                  {/if}
                  <strong>{authorName(message)}</strong>
                  <span class="muted">in #{channelName(message)}</span>
                  <time class="muted">{new Date(message.createdAt).toLocaleString()}</time>
                </span>
                <span class="search-result-text">{#each highlightParts(message.content) as part, index (index)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                {#if message.attachments.length > 0}
                  <span class="muted">
                    {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>

        {#if hasMore}
          <div class="editor-actions">
            <button type="button" onclick={loadMore} disabled={busy}>
              {busy ? 'Loading…' : 'Load older matches'}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
