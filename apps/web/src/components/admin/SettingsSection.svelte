<script lang="ts">
  import { onMount } from 'svelte';
  import type { Channel, ChannelListResponse, ServerSettingsResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let serverName = $state('');
  let requireInvite = $state(false);
  let embedsEnabled = $state(true);
  /** Empty string means "no default": fall back to the first channel. */
  let defaultChannelId = $state('');
  let channels = $state<Channel[]>([]);
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [settings, channelData] = await Promise.all([
        api<ServerSettingsResponse>('/settings'),
        api<ChannelListResponse>('/channels'),
      ]);
      serverName = settings.serverName;
      requireInvite = settings.requireInvite;
      embedsEnabled = settings.embedsEnabled;
      defaultChannelId = settings.defaultChannelId ?? '';
      channels = channelData.channels;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      const updated = await api<ServerSettingsResponse>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          serverName: serverName.trim(),
          requireInvite,
          embedsEnabled,
          defaultChannelId: defaultChannelId || null,
        }),
      });
      serverName = updated.serverName;
      requireInvite = updated.requireInvite;
      embedsEnabled = updated.embedsEnabled;
      defaultChannelId = updated.defaultChannelId ?? '';
      message = 'Settings saved.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Server settings</h3>
  <form onsubmit={save}>
    <label>
      Server name
      <input bind:value={serverName} required maxlength="64" />
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={requireInvite} />
      Require an invite code to register
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={embedsEnabled} />
      Link previews
    </label>
    <p class="muted">
      When on, the server fetches the first link in a message to show a small preview. This makes an
      outbound request to the linked site from your server.
    </p>

    <label>
      Default channel
      <select bind:value={defaultChannelId}>
        <option value="">First channel</option>
        {#each channels as channel (channel.id)}
          <option value={channel.id}># {channel.name}</option>
        {/each}
      </select>
    </label>
    <p class="muted">The channel that opens automatically when someone enters the server.</p>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
</section>
