<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    ALLOWED_IMAGE_TYPES,
    DEFAULT_ACCENT,
    DEFAULT_BACKGROUND,
    type Channel,
    type ChannelListResponse,
    type InstanceIconResponse,
    type ServerSettingsResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { meta } from '../../lib/meta.svelte';
  import { previewTheme, restoreTheme, setSavedTheme } from '../../lib/theme';

  let serverName = $state('');
  let requireInvite = $state(false);
  let embedsEnabled = $state(true);
  /** Empty string means "no default": fall back to the first channel. */
  let defaultChannelId = $state('');
  let channels = $state<Channel[]>([]);
  let themeBackground = $state(DEFAULT_BACKGROUND);
  let themeAccent = $state(DEFAULT_ACCENT);
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');
  let iconInput = $state<HTMLInputElement | null>(null);

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
      themeBackground = settings.theme.background ?? DEFAULT_BACKGROUND;
      themeAccent = settings.theme.accent ?? DEFAULT_ACCENT;
      channels = channelData.channels;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  });

  // Leaving the panel undoes any colour that was only being previewed.
  onDestroy(restoreTheme);

  function pickBackground(event: Event): void {
    themeBackground = (event.currentTarget as HTMLInputElement).value;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  function pickAccent(event: Event): void {
    themeAccent = (event.currentTarget as HTMLInputElement).value;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  function resetTheme(): void {
    themeBackground = DEFAULT_BACKGROUND;
    themeAccent = DEFAULT_ACCENT;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  async function uploadIcon(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    busy = true;
    error = null;
    message = null;
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api<InstanceIconResponse>('/icon', { method: 'PUT', body: form });
      meta.setIconHash(result.iconHash);
      message = 'Server icon updated.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function removeIcon(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      const result = await api<InstanceIconResponse>('/icon', { method: 'DELETE' });
      meta.setIconHash(result.iconHash);
      message = 'Server icon reset to the default.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

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
          theme: { background: themeBackground, accent: themeAccent },
        }),
      });
      serverName = updated.serverName;
      requireInvite = updated.requireInvite;
      embedsEnabled = updated.embedsEnabled;
      defaultChannelId = updated.defaultChannelId ?? '';
      themeBackground = updated.theme.background ?? DEFAULT_BACKGROUND;
      themeAccent = updated.theme.accent ?? DEFAULT_ACCENT;
      // Remember the saved palette, and keep the public meta in step, so the
      // restore above falls back to what is actually stored.
      setSavedTheme(updated.theme);
      if (meta.data) meta.data = { ...meta.data, theme: updated.theme };
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

    <fieldset>
      <legend>Colours</legend>
      <div class="inline">
        <label>
          Background
          <input type="color" value={themeBackground} oninput={pickBackground} />
        </label>
        <label>
          Accent
          <input type="color" value={themeAccent} oninput={pickAccent} />
        </label>
        <button type="button" onclick={resetTheme}>Reset colours</button>
      </div>
      <p class="muted">
        Panel shades, text and highlight tints are all derived from these two colours, and the text
        flips between dark and light on its own. Changes preview here immediately; save to keep them.
      </p>
    </fieldset>

    <fieldset>
      <legend>Icon</legend>
      <div class="server-icon-editor">
        <img class="server-icon large" src={meta.iconUrl} alt="" />
        <div class="editor-actions">
          <button type="button" onclick={() => iconInput?.click()} disabled={busy}>Upload icon</button>
          {#if meta.data?.iconHash}
            <button type="button" class="danger" onclick={removeIcon} disabled={busy}>Use default</button>
          {/if}
          <input
            class="file-input"
            type="file"
            accept={acceptAttribute}
            bind:this={iconInput}
            onchange={uploadIcon}
          />
        </div>
      </div>
      <p class="muted">
        Shown in the browser tab and beside the server name. Square images work best; PNG, JPEG, GIF
        or WebP.
      </p>
    </fieldset>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
</section>
