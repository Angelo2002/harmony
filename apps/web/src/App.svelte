<script lang="ts">
  import { onMount } from 'svelte';
  import type { MeResponse, ServerSettingsResponse } from '@harmony/shared';
  import { api } from './lib/api';
  import { meta } from './lib/meta.svelte';
  import { session } from './lib/session.svelte';
  import { ui } from './lib/ui.svelte';
  import AdminPanel from './components/admin/AdminPanel.svelte';
  import AuthPanel from './components/AuthPanel.svelte';
  import Chat from './components/Chat.svelte';
  import ProfileCard from './components/ProfileCard.svelte';
  import ProfilePanel from './components/ProfilePanel.svelte';
  import SetupWizard from './components/SetupWizard.svelte';

  let loading = $state(true);
  let setupOpen = $state(false);

  onMount(async () => {
    const metaPromise = meta.load();
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
      // The owner is walked through the setup once, on their first sign-in.
      if (me.user.isOwner) {
        const settings = await api<ServerSettingsResponse>('/settings');
        setupOpen = !settings.setupCompleted;
      }
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
  {#if setupOpen}
    <SetupWizard onclose={() => (setupOpen = false)} />
  {/if}
  <ProfileCard />
{:else}
  <AuthPanel />
{/if}
