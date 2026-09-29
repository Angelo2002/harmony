<script lang="ts">
  import { onMount } from 'svelte';
  import type { MeResponse } from '@harmony/shared';
  import { api } from './lib/api';
  import { meta } from './lib/meta.svelte';
  import { session } from './lib/session.svelte';
  import { ui } from './lib/ui.svelte';
  import AdminPanel from './components/admin/AdminPanel.svelte';
  import AuthPanel from './components/AuthPanel.svelte';
  import Chat from './components/Chat.svelte';
  import ProfilePanel from './components/ProfilePanel.svelte';

  let loading = $state(true);

  onMount(async () => {
    const metaPromise = meta.load();
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch {
      // Not signed in, or the server is unreachable — show the auth panel.
    }
    await metaPromise;
    loading = false;
  });
</script>

{#if loading}
  <main><p class="muted">Loading…</p></main>
{:else if session.user}
  <Chat />
  {#if ui.adminOpen}
    <AdminPanel />
  {/if}
  {#if ui.profileOpen}
    <ProfilePanel />
  {/if}
{:else}
  <AuthPanel />
{/if}
