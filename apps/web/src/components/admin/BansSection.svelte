<script lang="ts">
  import { onMount } from 'svelte';
  import type { Ban, BanListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let bans = $state<Ban[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function load(): Promise<void> {
    bans = (await api<BanListResponse>('/bans')).bans;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  async function unban(userId: string): Promise<void> {
    busy = true;
    error = null;
    try {
      await api(`/members/${userId}/ban`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Bans</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#if bans.length === 0}
    <p class="muted">Nobody is banned.</p>
  {:else}
    <ul class="rows">
      {#each bans as ban (ban.user.id)}
        <li class="member">
          <div class="member-head">
            <strong>{ban.user.displayName ?? ban.user.username}</strong>
            <span class="muted">@{ban.user.username}</span>
          </div>
          <p class="muted">
            {ban.reason ?? 'No reason given'}
            {#if ban.bannedBy}· by {ban.bannedBy.displayName ?? ban.bannedBy.username}{/if}
            · {new Date(ban.createdAt).toLocaleDateString()}
          </p>
          <div class="member-moderation">
            <button type="button" onclick={() => unban(ban.user.id)} disabled={busy}>Unban</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
