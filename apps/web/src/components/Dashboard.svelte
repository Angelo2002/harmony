<script lang="ts">
  import { onMount } from 'svelte';
  import { permissionsToNames } from '@harmony/shared';
  import { api } from '../lib/api';
  import { session } from '../lib/session.svelte';

  interface Health {
    status: string;
    database: string;
    gatewayVersion: number;
    uptimeSeconds: number;
  }

  let health = $state<Health | null>(null);

  const permissionNames = $derived(permissionsToNames(BigInt(session.permissions || '0')));

  onMount(async () => {
    try {
      health = await api<Health>('/health');
    } catch {
      health = null;
    }
  });

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    session.user = null;
    session.permissions = '0';
  }
</script>

<main>
  <header>
    <h1>Harmony</h1>
    <p class="muted">
      Signed in as <strong>{session.user?.username}</strong>
      {#if session.user?.isOwner}<span class="badge">owner</span>{/if}
    </p>
  </header>

  <section class="panel">
    <h2>Your permissions</h2>
    {#if permissionNames.length > 0}
      <ul class="chips">
        {#each permissionNames as name}<li>{name}</li>{/each}
      </ul>
    {:else}
      <p class="muted">No permissions granted.</p>
    {/if}
  </section>

  <section class="panel">
    <h2>Server</h2>
    {#if health}
      <p>
        status <strong>{health.status}</strong> · database <strong>{health.database}</strong> · gateway
        v{health.gatewayVersion} · up {health.uptimeSeconds}s
      </p>
    {:else}
      <p class="muted">Server not reachable.</p>
    {/if}
  </section>

  <div class="actions">
    <button type="button" onclick={logout}>Log out</button>
  </div>

  <p class="placeholder">Channels and messaging come next.</p>
</main>
