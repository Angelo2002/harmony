<script lang="ts">
  import { api } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { session } from '../lib/session.svelte';

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    session.user = null;
    session.permissions = '0';
  }
</script>

<aside class="sidebar">
  <header class="server-name">Harmony</header>

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
    <span class="username">{session.user?.username}</span>
    <button class="link" type="button" onclick={logout}>Log out</button>
  </footer>
</aside>
