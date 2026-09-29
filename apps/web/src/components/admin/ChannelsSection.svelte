<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    Category,
    Channel,
    ChannelListResponse,
    DiscordChannelListResponse,
    DiscordChannelOption,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let categories = $state<Category[]>([]);
  let channels = $state<Channel[]>([]);
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

{#snippet channelRow(channel: Channel)}
  <div class="row">
    {#if editing?.kind === 'channel' && editing.id === channel.id}
      <input bind:value={editing.name} />
      <button type="button" onclick={saveRename} disabled={busy}>Save</button>
      <button type="button" onclick={() => (editing = null)}>Cancel</button>
    {:else}
      <span class="grow"># {channel.name}</span>
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

  {#each categories as category (category.id)}
    <div class="group">
      <div class="group-head">
        {#if editing?.kind === 'category' && editing.id === category.id}
          <input bind:value={editing.name} />
          <button type="button" onclick={saveRename} disabled={busy}>Save</button>
          <button type="button" onclick={() => (editing = null)}>Cancel</button>
        {:else}
          <strong class="grow">{category.name}</strong>
          <button
            type="button"
            onclick={() => (editing = { kind: 'category', id: category.id, name: category.name })}>Rename</button
          >
          <button
            type="button"
            class="danger"
            onclick={() => run(() => api(`/categories/${category.id}`, { method: 'DELETE' }))}>Delete</button
          >
        {/if}
      </div>

      {#each channelsIn(category.id) as channel (channel.id)}
        {@render channelRow(channel)}
      {/each}
    </div>
  {/each}

  {#each channelsIn(null) as channel (channel.id)}
    {@render channelRow(channel)}
  {/each}
</section>
