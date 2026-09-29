<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    Category,
    Channel,
    ChannelListResponse,
    DiscordChannelListResponse,
    DiscordChannelOption,
    Role,
    RoleListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let categories = $state<Category[]>([]);
  let channels = $state<Channel[]>([]);
  let roles = $state<Role[]>([]);
  let discordChannels = $state<DiscordChannelOption[]>([]);
  let newChannelName = $state('');
  let newChannelCategory = $state('');
  let newChannelDiscord = $state('');
  let newCategoryName = $state('');
  let editing = $state<{ kind: 'channel' | 'category'; id: string; name: string } | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function load(): Promise<void> {
    const data = await api<ChannelListResponse>('/channels');
    categories = data.categories;
    channels = data.channels;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
    // @everyone is implicit, so it is never a useful requirement.
    void api<RoleListResponse>('/roles')
      .then((data) => {
        roles = data.roles.filter((role) => !role.isDefault);
      })
      .catch(() => {
        roles = [];
      });
    // Only available once the Discord bridge is connected; ignore failures.
    void api<DiscordChannelListResponse>('/bridge/channels')
      .then((data) => {
        discordChannels = data.channels;
      })
      .catch(() => {
        discordChannels = [];
      });
  });

  function channelsIn(categoryId: string | null): Channel[] {
    return channels.filter((channel) => channel.categoryId === categoryId);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = null;
    try {
      await action();
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function createChannel(event: SubmitEvent): void {
    event.preventDefault();
    const name = newChannelName.trim();
    if (!name) return;
    void run(async () => {
      await api('/channels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          categoryId: newChannelCategory || null,
          discordChannelId: newChannelDiscord || null,
        }),
      });
      newChannelName = '';
      newChannelDiscord = '';
    });
  }

  function createCategory(event: SubmitEvent): void {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    void run(async () => {
      await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
      newCategoryName = '';
    });
  }

  function setMapping(channel: Channel, discordChannelId: string): void {
    void run(async () => {
      await api(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ discordChannelId: discordChannelId || null }),
      });
    });
  }

  /** Recategorising sends the channel to the end of its new category. */
  function setCategory(channel: Channel, categoryId: string): void {
    void run(async () => {
      await api(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: categoryId || null }),
      });
    });
  }

  function moveChannel(channel: Channel, direction: 'up' | 'down'): void {
    void run(() => api(`/channels/${channel.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }));
  }

  function moveCategory(category: Category, direction: 'up' | 'down'): void {
    void run(() => api(`/categories/${category.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }));
  }

  /** Requires one role to see a channel or category. Empty means open. */
  function setRequiredRole(kind: 'channel' | 'category', id: string, roleId: string): void {
    void run(async () => {
      const path = kind === 'channel' ? `/channels/${id}` : `/categories/${id}`;
      await api(path, { method: 'PATCH', body: JSON.stringify({ requiredRoleId: roleId || null }) });
    });
  }

  function saveRename(): void {
    if (!editing) return;
    const { kind, id, name } = editing;
    void run(async () => {
      const path = kind === 'channel' ? `/channels/${id}` : `/categories/${id}`;
      await api(path, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      editing = null;
    });
  }
</script>

{#snippet moveButtons(index: number, count: number, onMove: (direction: 'up' | 'down') => void)}
  <button type="button" class="move" title="Move up" disabled={busy || index === 0} onclick={() => onMove('up')}
    >↑</button
  >
  <button
    type="button"
    class="move"
    title="Move down"
    disabled={busy || index === count - 1}
    onclick={() => onMove('down')}>↓</button
  >
{/snippet}

{#snippet roleSelect(kind: 'channel' | 'category', id: string, current: string | null)}
  <select title="Role required to see this" value={current ?? ''} onchange={(event) => setRequiredRole(kind, id, event.currentTarget.value)}>
    <option value="">Open to everyone</option>
    {#each roles as role (role.id)}
      <option value={role.id}>{role.name}</option>
    {/each}
  </select>
{/snippet}

{#snippet discordSelect(channel: Channel)}
  <select
    title="Discord channel to sync with"
    value={channel.discordChannelId ?? ''}
    onchange={(event) => setMapping(channel, event.currentTarget.value)}
  >
    <option value="">Not bridged</option>
    {#if channel.discordChannelId && !discordChannels.some((option) => option.id === channel.discordChannelId)}
      <option value={channel.discordChannelId}>{channel.discordChannelId}</option>
    {/if}
    {#each discordChannels as option (option.id)}
      <option value={option.id}>#{option.name}</option>
    {/each}
  </select>
{/snippet}

{#snippet channelRow(channel: Channel, index: number, count: number)}
  <div class="row channel-row">
    {#if editing?.kind === 'channel' && editing.id === channel.id}
      <input bind:value={editing.name} />
      <button type="button" onclick={saveRename} disabled={busy}>Save</button>
      <button type="button" onclick={() => (editing = null)}>Cancel</button>
    {:else}
      {@render moveButtons(index, count, (direction) => moveChannel(channel, direction))}
      <span class="grow"># {channel.name}</span>
      <select
        title="Category"
        value={channel.categoryId ?? ''}
        onchange={(event) => setCategory(channel, event.currentTarget.value)}
      >
        <option value="">No category</option>
        {#each categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select>
      {@render roleSelect('channel', channel.id, channel.requiredRoleId)}
      {@render discordSelect(channel)}
      <button
        type="button"
        onclick={() => (editing = { kind: 'channel', id: channel.id, name: channel.name })}>Rename</button
      >
      <button
        type="button"
        class="danger"
        onclick={() => run(() => api(`/channels/${channel.id}`, { method: 'DELETE' }))}>Delete</button
      >
    {/if}
  </div>
{/snippet}

{#snippet channelRows(list: Channel[])}
  {#each list as channel, index (channel.id)}
    {@render channelRow(channel, index, list.length)}
  {/each}
{/snippet}

<section>
  <h3>Channels</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  <div class="inline-forms">
    <form class="inline" onsubmit={createCategory}>
      <input bind:value={newCategoryName} placeholder="New category" required maxlength="64" />
      <button type="submit" disabled={busy}>Add category</button>
    </form>

    <form class="inline" onsubmit={createChannel}>
      <input bind:value={newChannelName} placeholder="New channel" required maxlength="64" />
      <select bind:value={newChannelCategory}>
        <option value="">No category</option>
        {#each categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select>
      <select bind:value={newChannelDiscord} title="Discord channel to sync with">
        <option value="">Not bridged</option>
        {#each discordChannels as option (option.id)}
          <option value={option.id}>#{option.name}</option>
        {/each}
      </select>
      <button type="submit" disabled={busy}>Add channel</button>
    </form>
  </div>

  {#if discordChannels.length === 0}
    <p class="muted">Connect the Discord bridge to link channels for syncing.</p>
  {/if}

  {#each categories as category, index (category.id)}
    {@const list = channelsIn(category.id)}
    <div class="group">
      <div class="group-head">
        {#if editing?.kind === 'category' && editing.id === category.id}
          <input bind:value={editing.name} />
          <button type="button" onclick={saveRename} disabled={busy}>Save</button>
          <button type="button" onclick={() => (editing = null)}>Cancel</button>
        {:else}
          {@render moveButtons(index, categories.length, (direction) => moveCategory(category, direction))}
          <strong class="grow">{category.name}</strong>
          {@render roleSelect('category', category.id, category.requiredRoleId)}
          <button
            type="button"
            onclick={() => (editing = { kind: 'category', id: category.id, name: category.name })}>Rename</button
          >
          <button
            type="button"
            class="danger"
            disabled={busy || list.length > 0}
            title={list.length === 0 ? 'Delete this category' : 'Move or delete its channels first'}
            onclick={() => run(() => api(`/categories/${category.id}`, { method: 'DELETE' }))}>Delete</button
          >
        {/if}
      </div>

      {@render channelRows(list)}
    </div>
  {/each}

  {@render channelRows(channelsIn(null))}
</section>
