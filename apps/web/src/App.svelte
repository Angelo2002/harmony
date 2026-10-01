<script lang="ts">
  import { onMount } from 'svelte';
  import type { MeResponse, ServerSettingsResponse } from '@harmony/shared';
  import { api } from './lib/api';
  import { meta } from './lib/meta.svelte';
  import { session } from './lib/session.svelte';
  import { ui } from './lib/ui.svelte';
  import AdminPanel from './components/admin/AdminPanel.svelte';
  import AboutPanel from './components/AboutPanel.svelte';
  import AuthPanel from './components/AuthPanel.svelte';
  import Chat from './components/Chat.svelte';
  import ProfileCard from './components/ProfileCard.svelte';
  import ProfilePanel from './components/ProfilePanel.svelte';
  import SearchPanel from './components/SearchPanel.svelte';
  import SetupWizard from './components/SetupWizard.svelte';

  let loading = $state(true);
  let setupOpen = $state(false);
  /**
   * The owner whose setup has already been looked up. A plain variable, not
   * `$state`: it is bookkeeping for the effect below, not something to render.
   */
  let setupCheckedFor: string | null = null;

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

  /*
   * Greets the owner the first time they are signed in. This watches the session
   * instead of running once on mount, because signing in happens on this very
   * page and does not reload it; running it in `onMount` alone meant the wizard
   * only appeared after a refresh.
   */
  $effect(() => {
    const user = session.user;
    if (!user?.isOwner) {
      setupCheckedFor = null;
      return;
    }
    if (setupCheckedFor === user.id) return;
    setupCheckedFor = user.id;
    void api<ServerSettingsResponse>('/settings')
      .then((settings) => {
        setupOpen = !settings.setupCompleted;
      })
      .catch(() => {
        // Not worth blocking the app over: the admin panel exposes everything
        // the wizard would have set.
      });
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
  {#if ui.aboutOpen}
    <AboutPanel />
  {/if}
  {#if ui.searchOpen}
    <SearchPanel onclose={() => ui.closeSearch()} />
  {/if}
  {#if setupOpen}
    <SetupWizard onclose={() => (setupOpen = false)} />
  {/if}
  <ProfileCard />
{:else}
  <AuthPanel />
{/if}
