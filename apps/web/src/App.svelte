<script lang="ts">
  import { onMount } from 'svelte';
  import type { MeResponse } from '@harmony/shared';
  import { api } from './lib/api';
  import { session } from './lib/session.svelte';
  import AuthPanel from './components/AuthPanel.svelte';
  import Dashboard from './components/Dashboard.svelte';

  let loading = $state(true);

  onMount(async () => {
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch {
      // Not signed in, or the server is unreachable — show the auth panel.
    } finally {
      loading = false;
    }
  });
</script>

{#if loading}
  <main><p class="muted">Loading…</p></main>
{:else if session.user}
  <Dashboard />
{:else}
  <AuthPanel />
{/if}
