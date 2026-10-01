<script lang="ts">
  import { Permission, hasPermission, type Channel } from '@harmony/shared';
  import { api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { channelGlyph } from '../lib/format';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';

  const permissions = $derived(BigInt(session.permissions || '0'));
  const canAdmin = $derived(
    hasPermission(permissions, Permission.ManageServer) ||
      hasPermission(permissions, Permission.ManageRoles) ||
      hasPermission(permissions, Permission.ManageChannels),
  );
  const myColor = $derived.by(() => {
    const color = session.user?.roleColor;
    return color == null ? null : `#${color.toString(16).padStart(6, '0')}`;
  });
  const myPicture = $derived(avatarUrl(session.user));

  /** Categories that demand a role; every channel inside one is locked too. */
  const lockedCategories = $derived(
    new Set(chat.categories.filter((category) => category.requiredRoleId !== null).map((category) => category.id)),
  );

  function isLocked(channel: Channel): boolean {
    return (
      channel.requiredRoleId !== null ||
      (channel.categoryId !== null && lockedCategories.has(channel.categoryId))
    );
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    session.user = null;
    session.permissions = '0';
  }

  /** Picking a channel closes the drawer on narrow screens. */
  function selectChannel(id: string): void {
    chat.selectChannel(id);
    ui.closeDrawers();
  }
</script>

<aside class="sidebar" class:open={ui.sidebarOpen}>
  <button class="server-name" type="button" title="About this instance" onclick={() => ui.openAbout()}>
    <img class="server-icon" src={meta.iconUrl} alt="" />
    <span class="server-name-text">{meta.serverName}</span>
  </button>

  <nav class="channels">
    {#each chat.categories as category (category.id)}
      <div class="category">
        <span class="category-name">{category.name}</span>
        {#each chat.channelsIn(category.id) as channel (channel.id)}
          <button
            class="channel"
            class:active={channel.id === chat.activeChannelId}
            type="button"
            onclick={() => selectChannel(channel.id)}
          >
            <span class="hash">{channelGlyph(channel)}</span>{channel.name}
            {#if isLocked(channel)}<span class="lock" title="Only members with a certain role can see this">🔒</span>{/if}
          </button>
        {/each}
      </div>
    {/each}

    {#each chat.channelsIn(null) as channel (channel.id)}
      <button
        class="channel"
        class:active={channel.id === chat.activeChannelId}
        type="button"
        onclick={() => selectChannel(channel.id)}
      >
        <span class="hash">{channelGlyph(channel)}</span>{channel.name}
        {#if isLocked(channel)}<span class="lock" title="Only members with a certain role can see this">🔒</span>{/if}
      </button>
    {/each}
  </nav>

  <footer class="user-bar">
    <button class="user-button" type="button" title="Edit your profile" onclick={() => ui.openProfile()}>
      {#if myPicture}
        <img class="avatar small" src={myPicture} alt="" />
      {:else}
        <span class="avatar small fallback">{initial(session.user)}</span>
      {/if}
      <span class="username" style={myColor ? `color: ${myColor}` : ''}>
        {session.user?.displayName ?? session.user?.username}
      </span>
    </button>

    <div class="user-actions">
      {#if canAdmin}
        <button class="link" type="button" onclick={() => ui.openAdmin()}>Admin</button>
      {/if}
      <button class="link" type="button" onclick={logout}>Log out</button>
    </div>
  </footer>
</aside>
