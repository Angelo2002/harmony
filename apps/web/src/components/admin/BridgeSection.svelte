<script lang="ts">
  import { onMount } from 'svelte';
  import type { BridgeResponse, DiscordChannelListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let status = $state<BridgeResponse | null>(null);
  let token = $state('');
  let enabled = $state(false);
  let discord = $state<DiscordChannelListResponse | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  function apply(data: BridgeResponse): void {
    status = data;
    enabled = data.enabled;
  }

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  onMount(() => {
    void api<BridgeResponse>('/bridge').then(apply).catch(fail);
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      const body: Record<string, unknown> = { enabled };
      // Blank means "keep the saved token".
      if (token.trim()) body.token = token.trim();
      apply(await api<BridgeResponse>('/bridge', { method: 'PATCH', body: JSON.stringify(body) }));
      token = '';
      message = 'Bridge settings saved.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function clearToken(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      apply(await api<BridgeResponse>('/bridge', { method: 'PATCH', body: JSON.stringify({ token: '' }) }));
      message = 'Token cleared.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function loadChannels(): Promise<void> {
    busy = true;
    error = null;
    try {
      discord = await api<DiscordChannelListResponse>('/bridge/channels');
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Discord bridge</h3>
  <p class="muted">
    Messages are mirrored both ways using a bot and per-channel webhooks. The bot needs the
    <em>Message Content</em> intent and the <em>Manage Webhooks</em> permission.
  </p>

  <form onsubmit={save}>
    <label>
      Bot token
      {#if status?.configured}<span class="muted">(saved — leave blank to keep it)</span>{/if}
      <input
        type="password"
        bind:value={token}
        placeholder={status?.configured ? '••••••••••••' : 'Paste your Discord bot token'}
        autocomplete="off"
      />
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={enabled} />
      Enable the bridge
    </label>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <div class="editor-actions">
      <button type="submit" disabled={busy}>Save</button>
      <button type="button" onclick={loadChannels} disabled={busy}>Load Discord channels</button>
      {#if status?.configured}
        <button type="button" class="danger" onclick={clearToken} disabled={busy}>Clear token</button>
      {/if}
    </div>
  </form>

  <div class="panel">
    <h2>Status</h2>
    {#if status?.status.ready}
      <p>
        Connected as <strong>{status.status.botTag}</strong>{#if status.status.guildName}
          in <strong>{status.status.guildName}</strong>{/if}.
      </p>
    {:else if status?.status.error}
      <p class="form-error">{status.status.error}</p>
    {:else if status?.configured && status.enabled}
      <p class="muted">Connecting…</p>
    {:else if status?.configured}
      <p class="muted">Configured, but the bridge is turned off.</p>
    {:else}
      <p class="muted">No bot token saved yet.</p>
    {/if}
  </div>

  {#if discord}
    <div class="panel">
      <h2>Discord channels{#if discord.guildName} <span class="muted">· {discord.guildName}</span>{/if}</h2>
      {#if discord.channels.length === 0}
        <p class="muted">No text channels found. Is the bot in a server?</p>
      {:else}
        <ul class="chips">
          {#each discord.channels as channel (channel.id)}<li>{channel.name}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>
