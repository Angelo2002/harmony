<script lang="ts">
  import { ui } from '../../lib/ui.svelte';
  import ChannelsSection from './ChannelsSection.svelte';
  import EmojisSection from './EmojisSection.svelte';
  import InvitesSection from './InvitesSection.svelte';
  import MembersSection from './MembersSection.svelte';
  import RolesSection from './RolesSection.svelte';
  import SettingsSection from './SettingsSection.svelte';

  const tabs = [
    { id: 'settings', label: 'Settings' },
    { id: 'roles', label: 'Roles' },
    { id: 'members', label: 'Members' },
    { id: 'channels', label: 'Channels' },
    { id: 'emojis', label: 'Emojis' },
    { id: 'invites', label: 'Invites' },
  ] as const;
  type TabId = (typeof tabs)[number]['id'];

  let active = $state<TabId>('settings');
</script>

<div class="admin-overlay">
  <div class="admin">
    <nav class="admin-nav">
      <h2>Admin</h2>
      {#each tabs as tab (tab.id)}
        <button class="admin-tab" class:active={active === tab.id} type="button" onclick={() => (active = tab.id)}>
          {tab.label}
        </button>
      {/each}
      <button class="admin-close" type="button" onclick={() => ui.closeAdmin()}>Close</button>
    </nav>

    <div class="admin-body">
      {#if active === 'settings'}
        <SettingsSection />
      {:else if active === 'roles'}
        <RolesSection />
      {:else if active === 'members'}
        <MembersSection />
      {:else if active === 'channels'}
        <ChannelsSection />
      {:else if active === 'emojis'}
        <EmojisSection />
      {:else}
        <InvitesSection />
      {/if}
    </div>
  </div>
</div>
