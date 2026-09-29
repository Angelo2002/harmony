<script lang="ts">
  import { Permission, hasPermission, type PermissionValue } from '@harmony/shared';
  import { session } from '../../lib/session.svelte';
  import { ui } from '../../lib/ui.svelte';
  import BansSection from './BansSection.svelte';
  import AuditSection from './AuditSection.svelte';
  import ChannelsSection from './ChannelsSection.svelte';
  import BridgeSection from './BridgeSection.svelte';
  import EmojisSection from './EmojisSection.svelte';
  import InvitesSection from './InvitesSection.svelte';
  import MediaSection from './MediaSection.svelte';
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
    | 'media'
    | 'retention'
    | 'bridge'
    | 'invites'
    | 'bans'
    | 'audit';

  // Each tab is shown only to someone who could actually use it.
  const tabs: Array<{ id: TabId; label: string; permission: PermissionValue }> = [
    { id: 'settings', label: 'Settings', permission: Permission.ManageServer },
    { id: 'roles', label: 'Roles', permission: Permission.ManageRoles },
    { id: 'members', label: 'Members', permission: Permission.ManageRoles },
    { id: 'channels', label: 'Channels', permission: Permission.ManageChannels },
    { id: 'emojis', label: 'Emojis', permission: Permission.ManageEmojis },
    { id: 'media', label: 'Media', permission: Permission.ManageServer },
    { id: 'retention', label: 'Retention', permission: Permission.ManageServer },
    { id: 'bridge', label: 'Bridge', permission: Permission.ManageServer },
    { id: 'invites', label: 'Invites', permission: Permission.ManageServer },
    { id: 'bans', label: 'Bans', permission: Permission.BanMembers },
    { id: 'audit', label: 'Log', permission: Permission.ManageServer },
  ];

  const permissions = $derived(BigInt(session.permissions || '0'));
  const visibleTabs = $derived(tabs.filter((tab) => hasPermission(permissions, tab.permission)));

  let selected = $state<TabId>('settings');
  // Fall back to the first available tab if the selected one is not permitted.
  const active = $derived(
    visibleTabs.some((tab) => tab.id === selected) ? selected : (visibleTabs[0]?.id ?? 'settings'),
  );
</script>

<div class="admin-overlay">
  <div class="admin">
    <nav class="admin-nav">
      <h2>Admin</h2>
      {#each visibleTabs as tab (tab.id)}
        <button class="admin-tab" class:active={active === tab.id} type="button" onclick={() => (selected = tab.id)}>
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
      {:else if active === 'media'}
        <MediaSection />
      {:else if active === 'retention'}
        <RetentionSection />
      {:else if active === 'bridge'}
        <BridgeSection />
      {:else if active === 'bans'}
        <BansSection />
      {:else if active === 'audit'}
        <AuditSection />
      {:else}
        <InvitesSection />
      {/if}
    </div>
  </div>
</div>
