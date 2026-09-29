<script lang="ts">
  import { Permission, hasPermission } from '@harmony/shared';
  import { api } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
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

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    session.user = null;
    session.permissions = '0';
  }
</script>

<aside class="sidebar">
  <header class="server-name">{meta.serverName}</header>

  <nav class="channels">
    {#each chat.categories as category (category.id)}
      <div class="category">
        <span class="category-name">{category.name}</span>
        {#each chat.channelsIn(category.id) as channel (channel.id)}
          <button
            class="channel"
            class:active={channel.id === chat.activeChannelId}
            type="button"
            onclick={() => chat.selectChannel(channel.id)}
          >
            <span class="hash">#</span>{channel.name}
          </button>
        {/each}
      </div>
    {/each}

    {#each chat.channelsIn(null) as channel (channel.id)}
      <button
        class="channel"
        class:active={channel.id === chat.activeChannelId}
        type="button"
        onclick={() => chat.selectChannel(channel.id)}
      >
        <span class="hash">#</span>{channel.name}
      </button>
    {/each}
  </nav>

  <footer class="user-bar">
    <span class="username" style={myColor ? `color: ${myColor}` : ''}>{session.user?.username}</span>
    <div class="user-actions">
      {#if canAdmin}
        <button class="link" type="button" onclick={() => ui.openAdmin()}>Admin</button>
      {/if}
      <button class="link" type="button" onclick={logout}>Log out</button>
    </div>
  </footer>
</aside>
