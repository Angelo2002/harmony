<script lang="ts">
  import { onMount } from 'svelte';
  import type { AuditEntry, AuditKind, AuditListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  const pageSize = 50;

  /** The badge shown against each entry. */
  const kindLabels: Record<AuditKind, string> = {
    message_delete: 'delete',
    message_edit: 'edit',
    timeout_add: 'timeout',
    timeout_clear: 'timeout lifted',
    kick: 'kick',
    ban: 'ban',
    unban: 'unban',
    role_add: 'role added',
    role_remove: 'role removed',
  };

  let entries = $state<AuditEntry[]>([]);
  let loading = $state(false);
  let loadedOnce = $state(false);
  let error = $state<string | null>(null);

  const hasMore = $derived(entries.length > 0 && entries.length % pageSize === 0);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      entries = (await api<AuditListResponse>(`/audit?limit=${pageSize}`)).entries;
      loadedOnce = true;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  /** Loads the page older than the last entry already held. */
  async function loadMore(): Promise<void> {
    const oldest = entries[entries.length - 1];
    if (!oldest) return;
    loading = true;
    error = null;
    try {
      const query = new URLSearchParams({ limit: String(pageSize), before: oldest.createdAt, beforeId: oldest.id });
      const older = await api<AuditListResponse>(`/audit?${query}`);
      entries = [...entries, ...older.entries];
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  function actorName(entry: AuditEntry): string {
    return entry.detail.actorName ?? entry.actor?.displayName ?? entry.actor?.username ?? 'someone';
  }

  function targetName(entry: AuditEntry): string {
    return entry.detail.targetName ?? entry.target?.displayName ?? entry.target?.username ?? 'a member';
  }

  /** The human half of the sentence; the actor name is rendered in front of it. */
  function describe(entry: AuditEntry): string {
    switch (entry.kind) {
      case 'message_delete':
        return `deleted a message in #${entry.detail.channelName ?? 'a channel'}`;
      case 'message_edit':
        return `edited a message in #${entry.detail.channelName ?? 'a channel'}`;
      case 'timeout_add':
        return `timed out ${targetName(entry)} for ${entry.detail.durationMinutes ?? '?'} minutes`;
      case 'timeout_clear':
        return `lifted the timeout on ${targetName(entry)}`;
      case 'kick':
        return `kicked ${targetName(entry)}`;
      case 'ban':
        return `banned ${targetName(entry)}`;
      case 'unban':
        return `unbanned ${targetName(entry)}`;
      case 'role_add':
        return `gave ${targetName(entry)} the ${entry.detail.roleName ?? 'unknown'} role`;
      case 'role_remove':
        return `took the ${entry.detail.roleName ?? 'unknown'} role from ${targetName(entry)}`;
    }
  }
</script>

<section>
  <h3>Audit log</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#if loading && !loadedOnce}
    <p class="muted">Loading…</p>
  {:else if entries.length === 0}
    <p class="muted">Nothing has been logged yet.</p>
  {:else}
    <ul class="rows audit">
      {#each entries as entry (entry.id)}
        <li class="audit-entry">
          <div class="audit-head">
            <span class="audit-kind kind-{entry.kind}">{kindLabels[entry.kind]}</span>
            <span class="audit-summary">
              <strong>{actorName(entry)}</strong>
              {describe(entry)}
            </span>
            <time class="muted">{new Date(entry.createdAt).toLocaleString()}</time>
          </div>

          {#if entry.detail.before !== undefined}
            <div class="audit-text">
              {#if entry.kind === 'message_edit'}
                <span class="audit-label">before</span>
                <p>{entry.detail.before}</p>
                <span class="audit-label">after</span>
                <p>{entry.detail.after}</p>
              {:else}
                <p>{entry.detail.before}</p>
              {/if}
            </div>
          {/if}

          {#if entry.detail.reason}
            <p class="audit-reason">Reason: {entry.detail.reason}</p>
          {/if}
        </li>
      {/each}
    </ul>

    <button type="button" onclick={loadMore} disabled={loading || !hasMore}>
      {#if loading}Loading…{:else if hasMore}Load older{:else}No more entries{/if}
    </button>
  {/if}
</section>
