<script lang="ts">
  import { onMount } from 'svelte';
  import type { Invite, InviteListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let invites = $state<Invite[]>([]);
  let maxUses = $state('');
  let expiresInHours = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function load(): Promise<void> {
    const data = await api<InviteListResponse>('/invites');
    invites = data.invites;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await api<Invite>('/invites', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: maxUses.trim() ? Number(maxUses) : undefined,
          expiresInHours: expiresInHours.trim() ? Number(expiresInHours) : undefined,
        }),
      });
      maxUses = '';
      expiresInHours = '';
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function revoke(code: string): Promise<void> {
    await api(`/invites/${code}`, { method: 'DELETE' });
    await load();
  }

  function describe(invite: Invite): string {
    const uses = invite.maxUses == null ? `${invite.uses} uses` : `${invite.uses}/${invite.maxUses} uses`;
    const expiry = invite.expiresAt ? `expires ${new Date(invite.expiresAt).toLocaleString()}` : 'never expires';
    return `${uses} · ${expiry}`;
  }
</script>

<section>
  <h3>Invites</h3>

  <form class="inline" onsubmit={create}>
    <input bind:value={maxUses} placeholder="Max uses (optional)" inputmode="numeric" />
    <input bind:value={expiresInHours} placeholder="Expires in hours (optional)" inputmode="numeric" />
    <button type="submit" disabled={busy}>Create invite</button>
  </form>

  {#if error}<p class="form-error">{error}</p>{/if}

  {#if invites.length === 0}
    <p class="muted">No invites yet.</p>
  {:else}
    <ul class="rows">
      {#each invites as invite (invite.code)}
        <li class="row">
          <code class="invite-code">{invite.code}</code>
          <span class="muted">{describe(invite)}</span>
          <button type="button" class="danger" onclick={() => revoke(invite.code)}>Revoke</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
