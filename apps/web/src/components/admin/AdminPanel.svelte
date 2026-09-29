<script lang="ts">
  import { Permission, hasPermission } from '@harmony/shared';
  import { session } from '../../lib/session.svelte';
  import { ui } from '../../lib/ui.svelte';
  import BansSection from './BansSection.svelte';
  import ChannelsSection from './ChannelsSection.svelte';
  import BridgeSection from './BridgeSection.svelte';
  import EmojisSection from './EmojisSection.svelte';
  import InvitesSection from './InvitesSection.svelte';
  import MembersSection from './MembersSection.svelte';
  import RetentionSection from './RetentionSection.svelte';
  import RolesSection from './RolesSection.svelte';
  import SettingsSection from './SettingsSection.svelte';

  type TabId =
    | 'settings'
    | 'roles'
    | 'members'
    | 'channels'
    | 'emojis'
    | 'retention'
    | 'bridge'
    | 'invites'
    | 'bans';

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'settings', label: 'Settings' },
    { id: 'roles', label: 'Roles' },
    { id: 'members', label: 'Members' },
    { id: 'channels', label: 'Channels' },
    { id: 'emojis', label: 'Emojis' },
    { id: 'retention', label: 'Retention' },
    { id: 'bridge', label: 'Bridge' },
    { id: 'invites', label: 'Invites' },
    { id: 'bans', label: 'Bans' },
  ];

  const permissions = $derived(BigInt(session.permissions || '0'));
  // The bans tab is only meaningful to someone who could lift a ban.
  const visibleTabs = $derived(
    tabs.filter((tab) => tab.id !== 'bans' || hasPermission(permissions, Permission.BanMembers)),
  );

  let active = $state<TabId>('settings');
</script>

<div class="admin-overlay">
  <div class="admin">
    <nav class="admin-nav">
      <h2>Admin</h2>
      {#each visibleTabs as tab (tab.id)}
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
      {:else if active === 'retention'}
        <RetentionSection />
      {:else if active === 'bridge'}
        <BridgeSection />
      {:else if active === 'bans'}
        <BansSection />
      {:else}
        <InvitesSection />
      {/if}
    </div>
  </div>
</div>
