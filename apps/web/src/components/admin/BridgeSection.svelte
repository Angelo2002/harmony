<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    BridgeImportResponse,
    BridgeResponse,
    Channel,
    ChannelListResponse,
    DiscordAuthResponse,
    DiscordChannelListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let status = $state<BridgeResponse | null>(null);
  let token = $state('');
  let enabled = $state(false);
  let publicBaseUrl = $state('');
  let discord = $state<DiscordChannelListResponse | null>(null);
  let harmonyChannels = $state<Channel[]>([]);
  let testChannelId = $state('');
  let testResult = $state<string | null>(null);
  let testOk = $state(false);
  let importChannelId = $state('');
  let importResult = $state<string | null>(null);
  let importOk = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  // The optional Discord sign-in integration, configured alongside the bot since
  // it is the very same Discord application.
  let discordAuth = $state<DiscordAuthResponse | null>(null);
  let clientId = $state('');
  let clientSecret = $state('');
  let authEnabled = $state(false);
  let authError = $state<string | null>(null);
  let authMessage = $state<string | null>(null);
  let authBusy = $state(false);

  function apply(data: BridgeResponse): void {
    status = data;
    enabled = data.enabled;
    publicBaseUrl = data.publicBaseUrl ?? '';
  }

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function applyAuth(data: DiscordAuthResponse): void {
    discordAuth = data;
    clientId = data.clientId ?? '';
    authEnabled = data.enabled;
  }

  async function saveDiscordAuth(): Promise<void> {
    authBusy = true;
    authError = null;
    authMessage = null;
    try {
      const body: Record<string, unknown> = { clientId: clientId.trim(), enabled: authEnabled };
      // Blank means "keep the saved secret", the same rule as the bot token.
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      applyAuth(await api<DiscordAuthResponse>('/discord/auth', { method: 'PATCH', body: JSON.stringify(body) }));
      clientSecret = '';
      authMessage = 'Discord sign-in settings saved.';
    } catch (cause) {
      authError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      authBusy = false;
    }
  }

  onMount(() => {
    void api<BridgeResponse>('/bridge').then(apply).catch(fail);
    void api<DiscordAuthResponse>('/discord/auth').then(applyAuth).catch(fail);
    void api<ChannelListResponse>('/channels')
      .then((data) => {
        harmonyChannels = data.channels;
      })
      .catch(() => {
        harmonyChannels = [];
      });
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      const body: Record<string, unknown> = { enabled, publicBaseUrl: publicBaseUrl.trim() };
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

  async function importHistory(): Promise<void> {
    if (!importChannelId) return;
    busy = true;
    error = null;
    importResult = null;
    try {
      const result = await api<BridgeImportResponse>('/bridge/import', {
        method: 'POST',
        body: JSON.stringify({ channelId: importChannelId }),
      });
      importOk = true;
      importResult =
        result.imported === 0
          ? 'Nothing new to import — that channel is already up to date.'
          : `Imported ${result.imported} message${result.imported === 1 ? '' : 's'}.`;
    } catch (cause) {
      importOk = false;
      importResult = cause instanceof ApiError ? cause.message : String(cause);
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

  async function sendTest(): Promise<void> {
    if (!testChannelId) return;
    busy = true;
    error = null;
    message = null;
    testResult = null;
    try {
      await api('/bridge/test', { method: 'POST', body: JSON.stringify({ channelId: testChannelId }) });
      testOk = true;
      testResult = 'Test message sent — check the Discord channel.';
    } catch (cause) {
      // Show the underlying Discord error instead of a generic failure.
      testOk = false;
      testResult = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Discord bridge</h3>
  <p class="muted">
    Messages are mirrored both ways using a bot and per-channel webhooks. The bot needs the
    <em>Message Content</em> and <em>Presence</em> intents and the <em>Manage Webhooks</em> permission.
    Restart Harmony after changing intents, since the bot only reads them when it reconnects.
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

    <label>
      Public base URL <span class="muted">(optional)</span>
      <input
        type="url"
        bind:value={publicBaseUrl}
        placeholder="https://chat.example.com"
        autocomplete="off"
      />
      <span class="muted">
        The address people use to reach this instance. Needed so Discord can fetch Harmony
        profile pictures for mirrored messages; a <code>localhost</code> address will not work.
      </span>
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

  <div class="panel">
    <h2>Sign in with Discord</h2>
    <p class="muted">
      Optional, and off by default. Lets members sign in with Discord and connect their account from
      their profile, proving it is really theirs. It uses the same Discord application as the bot:
      add the callback URL below under <em>OAuth2 → Redirects</em> in the Discord developer portal,
      then paste the client id and secret here.
    </p>

    <form
      onsubmit={(event) => {
        event.preventDefault();
        void saveDiscordAuth();
      }}
    >
      <label>
        Client ID
        <input bind:value={clientId} autocomplete="off" placeholder="e.g. 123456789012345678" />
      </label>

      <label>
        Client secret
        {#if discordAuth?.configured}<span class="muted">(saved — leave blank to keep it)</span>{/if}
        <input
          type="password"
          bind:value={clientSecret}
          autocomplete="off"
          placeholder={discordAuth?.configured ? '••••••••••••' : 'Paste the client secret'}
        />
      </label>

      <label class="checkbox">
        <input type="checkbox" bind:checked={authEnabled} />
        Allow members to sign in and link with Discord
      </label>

      {#if discordAuth?.redirectUri}
        <p class="muted">Callback URL to register: <code>{discordAuth.redirectUri}</code></p>
      {:else}
        <p class="muted">
          Set a <strong>Public base URL</strong> above first — Discord needs an address it can reach.
        </p>
      {/if}

      {#if authError}<p class="form-error">{authError}</p>{/if}
      {#if authMessage}<p class="ok-text">{authMessage}</p>{/if}

      <div class="editor-actions">
        <button type="submit" disabled={authBusy}>Save</button>
      </div>
    </form>
  </div>

  <div class="panel">
    <h2>Test a channel</h2>
    <div class="inline">
      <select bind:value={testChannelId}>
        <option value="">Pick a Harmony channel…</option>
        {#each harmonyChannels as channel (channel.id)}
          <option value={channel.id}>#{channel.name}{channel.discordChannelId ? ' (bridged)' : ''}</option>
        {/each}
      </select>
      <button type="button" onclick={sendTest} disabled={busy || !testChannelId}>Send test message</button>
    </div>
    {#if testResult}
      <p class={testOk ? 'ok-text' : 'form-error'}>{testResult}</p>
    {/if}
  </div>

  <div class="panel">
    <h2>Import history</h2>
    <p class="muted">
      Newly linked channels backfill automatically, but you can also pull a bridged channel's recent
      Discord messages on demand. Anything already imported is skipped, so it is safe to run again.
    </p>
    <div class="inline">
      <select bind:value={importChannelId}>
        <option value="">Pick a bridged Harmony channel…</option>
        {#each harmonyChannels.filter((channel) => channel.discordChannelId) as channel (channel.id)}
          <option value={channel.id}>#{channel.name}</option>
        {/each}
      </select>
      <button type="button" onclick={importHistory} disabled={busy || !importChannelId}>Import recent messages</button>
    </div>
    {#if importResult}
      <p class={importOk ? 'ok-text' : 'form-error'}>{importResult}</p>
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
