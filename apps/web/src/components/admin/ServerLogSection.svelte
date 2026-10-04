<script lang="ts">
  import { onMount } from 'svelte';
  import type { ServerLogEntry, ServerLogLevel, ServerLogListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  const pageSize = 50;

  /** The severity choices offered above the list. `''` is "All". */
  const levelFilters: ReadonlyArray<{ value: ServerLogLevel | ''; label: string }> = [
    { value: '', label: 'All' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warn' },
    { value: 'error', label: 'Error' },
  ];

  let entries = $state<ServerLogEntry[]>([]);
  let level = $state<ServerLogLevel | ''>('');
  let loading = $state(false);
  let loadedOnce = $state(false);
  let busy = $state(false);
  let confirmingClear = $state(false);
  let error = $state<string | null>(null);

  const hasMore = $derived(entries.length > 0 && entries.length % pageSize === 0);

  /** Newest first, whatever order a page came back in, so paging stays stable. */
  function newestFirst(list: ServerLogEntry[]): ServerLogEntry[] {
    return [...list].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }

  /** The entry older than every other one held; the cursor for the next page. */
  function oldest(held: ServerLogEntry[]): ServerLogEntry | undefined {
    return held.reduce<ServerLogEntry | undefined>(
      (min, entry) => (min === undefined || entry.lastAt <= min.lastAt ? entry : min),
      undefined,
    );
  }

  function merge(existing: ServerLogEntry[], incoming: ServerLogEntry[]): ServerLogEntry[] {
    const byId = new Map<string, ServerLogEntry>();
    for (const entry of [...existing, ...incoming]) byId.set(entry.id, entry);
    return newestFirst([...byId.values()]);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (level) query.set('level', level);
      const result = await api<ServerLogListResponse>(`/server-log?${query}`);
      entries = newestFirst(result.entries);
      loadedOnce = true;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  /** Loads the page older than the last entry already held. */
  async function loadMore(): Promise<void> {
    const cursor = oldest(entries);
    if (!cursor) return;
    loading = true;
    error = null;
    try {
      const query = new URLSearchParams({ limit: String(pageSize), before: cursor.lastAt, beforeId: cursor.id });
      if (level) query.set('level', level);
      const older = await api<ServerLogListResponse>(`/server-log?${query}`);
      entries = merge(entries, older.entries);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  /** Switching the filter starts a fresh page at the newest entry. */
  function selectLevel(value: ServerLogLevel | ''): void {
    if (value === level) return;
    level = value;
    entries = [];
    loadedOnce = false;
    void load();
  }

  onMount(() => void load());

  async function clearLog(): Promise<void> {
    busy = true;
    error = null;
    try {
      await api('/server-log', { method: 'DELETE' });
      entries = [];
      loadedOnce = true;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
      confirmingClear = false;
    }
  }

  /** The structured context as readable key/value rows, not raw JSON. */
  function detailRows(detail: Record<string, unknown>): Array<[string, string]> {
    return Object.entries(detail)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => [key, formatValue(value)]);
  }

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(formatValue).join(', ');
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([key, nested]) => `${key}: ${formatValue(nested)}`)
        .join(', ');
    }
    return String(value);
  }

  function formatTime(value: string): string {
    return new Date(value).toLocaleString();
  }
</script>

<section>
  <h3>Server log</h3>

  <div class="server-log-filters">
    {#each levelFilters as filter (filter.value)}
      <button
        type="button"
        class="server-log-filter"
        class:active={level === filter.value}
        onclick={() => selectLevel(filter.value)}
      >
        {filter.label}
      </button>
    {/each}
  </div>

  {#if error}<p class="form-error">{error}</p>{/if}

  {#if loading && !loadedOnce}
    <p class="muted">Loading…</p>
  {:else if entries.length === 0}
    <p class="muted">{level ? 'No entries at this level.' : 'Nothing logged yet.'}</p>
  {:else}
    <ul class="rows audit">
      {#each entries as entry (entry.id)}
        <li class="audit-entry">
          <div class="audit-head">
            <span class="server-log-level level-{entry.level}">{entry.level}</span>
            <span class="audit-summary">
              <code class="server-log-event">{entry.event}</code>
              <span class="server-log-message">{entry.message}</span>
            </span>
            <time class="muted">
              {#if entry.count > 1}
                ×{entry.count} · {formatTime(entry.firstAt)} – {formatTime(entry.lastAt)}
              {:else}
                {formatTime(entry.lastAt)}
              {/if}
            </time>
          </div>

          {#if detailRows(entry.detail).length > 0}
            <dl class="server-log-detail">
              {#each detailRows(entry.detail) as [key, value] (key)}
                <dt>{key}</dt>
                <dd>{value}</dd>
              {/each}
            </dl>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="editor-actions">
      <button type="button" onclick={loadMore} disabled={loading || !hasMore}>
        {#if loading}Loading…{:else if hasMore}Load older{:else}No more entries{/if}
      </button>

      {#if confirmingClear}
        <button type="button" class="danger" onclick={clearLog} disabled={busy}>Confirm clear</button>
        <button type="button" onclick={() => (confirmingClear = false)}>Cancel</button>
      {:else}
        <button type="button" class="danger" onclick={() => (confirmingClear = true)}>Clear log</button>
      {/if}
    </div>
  {/if}
</section>
