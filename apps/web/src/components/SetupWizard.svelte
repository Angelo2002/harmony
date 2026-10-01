<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    ALLOWED_IMAGE_TYPES,
    DEFAULT_ACCENT,
    DEFAULT_BACKGROUND,
    type BridgeResponse,
    type ChannelImportResponse,
    type DiscordChannelImportPreview,
    type DiscordEmojiListResponse,
    type EmojiImportResponse,
    type InstanceIconResponse,
    type RetentionResponse,
    type ServerSettingsResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { meta } from '../lib/meta.svelte';
  import { previewTheme, restoreTheme, setSavedTheme } from '../lib/theme';

  let { onclose }: { onclose: () => void } = $props();

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');
  const steps = ['Welcome', 'Server', 'Storage', 'Discord', 'Channels', 'Emoji', 'Ready'];

  let step = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Step 1: the instance itself.
  let serverName = $state('');
  let requireInvite = $state(false);
  let background = $state<string>(DEFAULT_BACKGROUND);
  let accent = $state<string>(DEFAULT_ACCENT);
  let iconInput = $state<HTMLInputElement | null>(null);

  // Step 2: what to keep, in days. Blank means "keep forever".
  let imageDays = $state('');
  let videoDays = $state('');
  let messageDays = $state('');

  // Step 3: the Discord bridge.
  let token = $state('');
  let publicBaseUrl = $state('');
  let bridge = $state<BridgeResponse | null>(null);

  // Steps 4 and 5: what to bring over from Discord.
  let channelPreview = $state<DiscordChannelImportPreview | null>(null);
  let selectedChannels = $state<Set<string>>(new Set());
  let emojiPreview = $state<DiscordEmojiListResponse | null>(null);
  let selectedEmojis = $state<Set<string>>(new Set());
  let importSummary = $state<string | null>(null);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  onMount(async () => {
    try {
      const settings = await api<ServerSettingsResponse>('/settings');
      serverName = settings.serverName;
      requireInvite = settings.requireInvite;
      background = settings.theme.background ?? DEFAULT_BACKGROUND;
      accent = settings.theme.accent ?? DEFAULT_ACCENT;
    } catch (cause) {
      fail(cause);
    }

    try {
      const retention = await api<RetentionResponse>('/retention');
      imageDays = retention.settings.imageRetentionDays == null ? '' : String(retention.settings.imageRetentionDays);
      videoDays = retention.settings.videoRetentionDays == null ? '' : String(retention.settings.videoRetentionDays);
      messageDays =
        retention.settings.messageRetentionDays == null ? '' : String(retention.settings.messageRetentionDays);
    } catch {
      // Retention is optional here; leave the fields blank and move on.
    }

    bridge = await api<BridgeResponse>('/bridge').catch(() => null);
    publicBaseUrl = bridge?.publicBaseUrl ?? '';
  });

  // A theme the owner previews but never saves should not outlive the wizard.
  onDestroy(restoreTheme);

  function toDays(value: string): number | null {
    const parsed = Number(value.trim());
    if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed);
  }

  function toggle(set: Set<string>, id: string, on: boolean): Set<string> {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }

  async function uploadIcon(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    busy = true;
    error = null;
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api<InstanceIconResponse>('/icon', { method: 'PUT', body: form });
      meta.setIconHash(result.iconHash);
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function saveServer(): Promise<boolean> {
    busy = true;
    error = null;
    try {
      const name = serverName.trim();
      const body: Record<string, unknown> = { requireInvite, theme: { background, accent } };
      if (name.length > 0) body.serverName = name;
      const updated = await api<ServerSettingsResponse>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      serverName = updated.serverName;
      setSavedTheme(updated.theme);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      busy = false;
    }
  }

  async function saveStorage(): Promise<boolean> {
    busy = true;
    error = null;
    try {
      await api('/retention', {
        method: 'PATCH',
        body: JSON.stringify({
          imageRetentionDays: toDays(imageDays),
          videoRetentionDays: toDays(videoDays),
          messageRetentionDays: toDays(messageDays),
        }),
      });
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      busy = false;
    }
  }

  async function saveBridge(): Promise<boolean> {
    // Nothing to save when no token was entered and none is stored.
    if (!token.trim() && !bridge?.configured) return true;

    busy = true;
    error = null;
    try {
      const body: Record<string, unknown> = { enabled: true, publicBaseUrl: publicBaseUrl.trim() };
      if (token.trim()) body.token = token.trim();
      bridge = await api<BridgeResponse>('/bridge', { method: 'PATCH', body: JSON.stringify(body) });
      token = '';
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      busy = false;
    }

    // The bot connects in the background, so give it a moment: the next two
    // steps can only list anything once it is online.
    await waitForBridge();
    return true;
  }

  /** Polls the bridge for a few seconds, so the import steps have something to list. */
  async function waitForBridge(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const status = await api<BridgeResponse>('/bridge').catch(() => null);
      if (status) bridge = status;
      // Ready, or it failed for a reason waiting will not fix.
      if (status?.status.ready || status?.status.error) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  async function loadChannels(): Promise<void> {
    busy = true;
    error = null;
    try {
      const preview = await api<DiscordChannelImportPreview>('/channels/discord');
      channelPreview = preview;
      selectedChannels = new Set(
        preview.groups.flatMap((group) =>
          group.channels.filter((channel) => !channel.bridged).map((channel) => channel.id),
        ),
      );
    } catch (cause) {
      channelPreview = null;
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function importChannels(): Promise<void> {
    busy = true;
    error = null;
    let done = false;
    try {
      const result = await api<ChannelImportResponse>('/channels/import', {
        method: 'POST',
        body: JSON.stringify({ channelIds: [...selectedChannels] }),
      });
      importSummary =
        result.imported === 0
          ? 'Nothing new to import.'
          : `Imported ${result.imported} channel${result.imported === 1 ? '' : 's'}` +
            (result.categoriesCreated > 0 ? ` and ${result.categoriesCreated} categories` : '') +
            '.';
      channelPreview = null;
      done = true;
    } catch (cause) {
      fail(cause);
    }
    busy = false;
    // The step's whole point is the import, so it moves on by itself rather than
    // waiting for a button that does nothing else.
    if (done) advance();
  }

  async function loadEmojis(): Promise<void> {
    busy = true;
    error = null;
    try {
      const preview = await api<DiscordEmojiListResponse>('/emojis/discord');
      emojiPreview = preview;
      selectedEmojis = new Set(preview.emojis.filter((emoji) => !emoji.imported).map((emoji) => emoji.id));
    } catch (cause) {
      emojiPreview = null;
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function importEmojis(): Promise<void> {
    busy = true;
    error = null;
    let done = false;
    try {
      const result = await api<EmojiImportResponse>('/emojis/import', {
        method: 'POST',
        body: JSON.stringify({ emojiIds: [...selectedEmojis] }),
      });
      importSummary =
        result.imported > 0
          ? `Imported ${result.imported} emoji.`
          : result.skipped > 0
            ? 'Every one of those is already here.'
            : 'Nothing was imported.';
      emojiPreview = null;
      done = true;
    } catch (cause) {
      fail(cause);
    }
    busy = false;
    if (done) advance();
  }

  /** Advances, saving whatever the step collects. A failed save stays put. */
  async function next(): Promise<void> {
    if (step === 1 && !(await saveServer())) return;
    if (step === 2 && !(await saveStorage())) return;
    if (step === 3 && !(await saveBridge())) return;
    advance();
  }

  /** Leaves a step without saving anything in it. */
  function skip(): void {
    error = null;
    importSummary = null;
    advance();
  }

  function advance(): void {
    step += 1;
    if (step === 4) void loadChannels();
    if (step === 5) void loadEmojis();
  }

  /** Going back re-lists the step's preview, since importing cleared it. */
  function back(): void {
    if (step === 0) return;
    error = null;
    importSummary = null;
    step -= 1;
    if (step === 4) void loadChannels();
    if (step === 5) void loadEmojis();
  }

  /** Marks the wizard done, so it does not greet the owner again. */
  async function finish(): Promise<void> {
    busy = true;
    error = null;
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ setupCompleted: true }) });
    } catch (cause) {
      fail(cause);
      busy = false;
      return;
    }
    busy = false;
    onclose();
  }

  /** True once the bot is online, which the Discord panel reports as ready. */
  const bridgeReady = $derived(bridge?.status.ready === true);
</script>

<div class="admin-overlay">
  <div class="admin setup-wizard">
    <div class="admin-body">
      <ol class="wizard-steps">
        {#each steps as label, index (label)}
          <li class:active={index === step} class:done={index < step}>{label}</li>
        {/each}
      </ol>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if step === 0}
        <h3>Welcome to {meta.serverName}</h3>
        <p>
          Harmony is a free, open-source chat server you host yourself — a small-community alternative to
          Discord that does not ask your members to move anywhere they do not want to go. Your messages,
          your images and your members' data stay on your own machine, under your own rules: no ID
          verification, no data mining, nobody's terms of service but your own.
        </p>
        <p class="muted">
          This short setup walks through the handful of choices worth making before you invite anyone. Every
          one of them can be changed later in the admin panel.
        </p>
        <div class="editor-actions">
          <button type="button" onclick={next} disabled={busy}>Get started</button>
          <button type="button" onclick={finish} disabled={busy}>Skip setup</button>
        </div>

      {:else if step === 1}
        <h3>Name and look</h3>
        <p class="muted">All of this is optional, and nothing here is permanent.</p>

        <div class="server-icon-editor">
          <img class="server-icon large" src={meta.iconUrl} alt="" />
          <div class="editor-actions">
            <button type="button" onclick={() => iconInput?.click()} disabled={busy}>Upload icon</button>
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
          How the icon looks installed on a phone or desktop — how much room to leave around it, and
          what colour behind it — is in <strong>Admin → Settings</strong>, where you can see a preview.
        </p>

        <label>
          Server name
          <input bind:value={serverName} maxlength="64" placeholder="Harmony" />
        </label>

        <div class="wizard-colours">
          <label>
            Background
            <input
              type="color"
              bind:value={background}
              oninput={(event) => previewTheme({ background: event.currentTarget.value, accent })}
            />
          </label>
          <label>
            Accent
            <input
              type="color"
              bind:value={accent}
              oninput={(event) => previewTheme({ background, accent: event.currentTarget.value })}
            />
          </label>
        </div>

        <label class="checkbox">
          <input type="checkbox" bind:checked={requireInvite} />
          Require an invite code to register
        </label>
        <p class="muted">
          With this on, only people you invite (Admin → Invites) can create an account. You can leave it off
          for an open server, and change it at any time.
        </p>
        <div class="editor-actions">
          <button type="button" onclick={next} disabled={busy}>Continue</button>
          <button type="button" onclick={skip} disabled={busy}>Skip</button>
        </div>

      {:else if step === 2}
        <h3>Storage</h3>
        <p class="muted">
          Harmony can clean up after itself so a small machine never fills up. Each rule is independent, and
          leaving a field blank keeps that content forever. The emergency storage cap lives in the admin
          panel later.
        </p>
        <label>
          Delete images after (days)
          <input bind:value={imageDays} placeholder="keep forever" inputmode="numeric" />
        </label>
        <label>
          Delete videos after (days)
          <input bind:value={videoDays} placeholder="keep forever" inputmode="numeric" />
        </label>
        <label>
          Delete messages after (days)
          <input bind:value={messageDays} placeholder="keep forever" inputmode="numeric" />
        </label>
        <div class="editor-actions">
          <button type="button" onclick={next} disabled={busy}>Continue</button>
          <button type="button" onclick={skip} disabled={busy}>Skip</button>
        </div>

      {:else if step === 3}
        <h3>Discord bridge</h3>
        <p class="muted">
          The bridge mirrors messages both ways, so your community can keep its Discord habits while moving
          over. It needs a bot of your own:
        </p>
        <ol class="wizard-help">
          <li>Open the <strong>Discord Developer Portal</strong> and create an application.</li>
          <li>On the <strong>Bot</strong> page, create the bot and copy its token.</li>
          <li>Turn on the <strong>Message Content</strong> and <strong>Presence</strong> intents. Both are
            privileged: the toggles work right away for a bot in fewer than 100 servers, and need Discord's
            approval beyond that. Message Content is what lets the bridge read messages; Presence is what
            tells Harmony who is online on the Discord side.</li>
          <li>Invite the bot with <strong>View Channels</strong>, <strong>Send Messages</strong>,
            <strong>Read Message History</strong>, <strong>Add Reactions</strong> and
            <strong>Manage Webhooks</strong>.</li>
          <li>Save your changes, then restart Harmony. The bot picks up the intents when it reconnects.</li>
        </ol>

        <label>
          Bot token
          {#if bridge?.configured}<span class="muted">(saved — leave blank to keep it)</span>{/if}
          <input type="password" bind:value={token} autocomplete="off" placeholder="Paste your bot token" />
        </label>
        <label>
          Public base URL <span class="muted">(optional)</span>
          <input type="url" bind:value={publicBaseUrl} autocomplete="off" placeholder="https://chat.example.com" />
          <span class="muted">
            How people reach this instance from the internet. Needed for profile pictures to mirror; a
            <code>localhost</code> address will not work.
          </span>
        </label>

        {#if bridge?.status.error}
          <p class="form-error">{bridge.status.error}</p>
        {/if}
        {#if bridgeReady}
          <p class="ok-text">Connected as {bridge?.status.botTag}.</p>
        {/if}

        <div class="editor-actions">
          <button type="button" onclick={next} disabled={busy}>Connect</button>
          <button type="button" onclick={skip} disabled={busy}>Skip</button>
        </div>

      {:else if step === 4}
        <h3>Bring your channels over</h3>
        {#if importSummary}<p class="ok-text">{importSummary}</p>{/if}
        {#if channelPreview}
          {#if channelPreview.guildName === null}
            <p class="muted">The bridge is not connected. Save a token in the previous step, then try again.</p>
          {:else}
            <p class="muted">
              Ticked channels are created here and linked to Discord for syncing. Everything not yet bridged
              starts ticked; untick anything you would rather bring over later.
            </p>
            {#each channelPreview.groups as group (group.categoryName ?? '')}
              <div class="group">
                <div class="group-head"><strong class="grow">{group.categoryName ?? 'No category'}</strong></div>
                <ul class="import-list">
                  {#each group.channels as channel (channel.id)}
                    <li>
                      <label class="checkbox">
                        <input
                          type="checkbox"
                          disabled={channel.bridged || busy}
                          checked={channel.bridged || selectedChannels.has(channel.id)}
                          onchange={(event) =>
                            (selectedChannels = toggle(selectedChannels, channel.id, event.currentTarget.checked))}
                        />
                        #{channel.name}
                        {#if channel.bridged}<span class="muted">already bridged</span>{/if}
                      </label>
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
          {/if}
        {:else if busy}
          <p class="muted">Listing the Discord channels…</p>
        {:else}
          <p class="muted">
            The channel list could not be loaded. If the bridge has not connected yet, check the token in the
            previous step; you can also import channels later from Admin → Channels.
          </p>
        {/if}

        <div class="editor-actions">
          {#if channelPreview && channelPreview.guildName !== null}
            <button type="button" onclick={importChannels} disabled={busy || selectedChannels.size === 0}>
              Import {selectedChannels.size} selected
            </button>
          {:else}
            <button type="button" onclick={loadChannels} disabled={busy}>Try again</button>
          {/if}
          <button type="button" onclick={skip} disabled={busy}>Skip</button>
        </div>

      {:else if step === 5}
        <h3>Bring your emoji over</h3>
        {#if importSummary}<p class="ok-text">{importSummary}</p>{/if}
        {#if emojiPreview}
          {#if emojiPreview.guildName === null}
            <p class="muted">The bridge is not connected. Save a token two steps back, then try again.</p>
          {:else if emojiPreview.emojis.length === 0}
            <p class="muted">No custom emoji found in <strong>{emojiPreview.guildName}</strong>.</p>
          {:else}
            <p class="muted">
              {emojiPreview.emojis.length} emoji in <strong>{emojiPreview.guildName}</strong>. Ones Harmony
              already has are skipped by name.
            </p>
            <ul class="import-list">
              {#each emojiPreview.emojis as emoji (emoji.id)}
                <li>
                  <label class="checkbox">
                    <input
                      type="checkbox"
                      disabled={emoji.imported || busy}
                      checked={emoji.imported || selectedEmojis.has(emoji.id)}
                      onchange={(event) =>
                        (selectedEmojis = toggle(selectedEmojis, emoji.id, event.currentTarget.checked))}
                    />
                    :{emoji.name}:
                    {#if emoji.imported}<span class="muted">already here</span>{/if}
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if busy}
          <p class="muted">Listing the Discord emoji…</p>
        {:else}
          <p class="muted">
            The emoji list could not be loaded. If the bridge has not connected yet, check the token two
            steps back; you can also import emoji later from Admin → Emojis.
          </p>
        {/if}

        <div class="editor-actions">
          {#if emojiPreview && emojiPreview.guildName !== null && emojiPreview.emojis.length > 0}
            <button type="button" onclick={importEmojis} disabled={busy || selectedEmojis.size === 0}>
              Import {selectedEmojis.size} selected
            </button>
          {:else}
            <button type="button" onclick={loadEmojis} disabled={busy}>Try again</button>
          {/if}
          <button type="button" onclick={skip} disabled={busy}>Skip</button>
        </div>

      {:else}
        <h3>You are ready</h3>
        <p>
          That is the instance set up. A few things worth knowing before you invite everyone:
        </p>
        <ul class="wizard-help">
          <li>
            <strong>Roles do not carry over from Discord.</strong> The whole permission set is yours to
            build fresh — set up roles and their colours in the admin panel, then hand them out on the
            Members tab.
          </li>
          <li>
            <strong>Your members sign up with a username and password.</strong> There is no email, so if
            someone forgets theirs, an admin sets a new one from the Members tab.
          </li>
          <li>
            <strong>Invites</strong> live in the admin panel, and <strong>retention</strong> there too, if
            you want Harmony to clean up after itself.
          </li>
        </ul>
        <div class="editor-actions">
          <button type="button" onclick={finish} disabled={busy}>Enter {meta.serverName}</button>
        </div>
      {/if}

      {#if step > 0}
        <div class="wizard-footer">
          <button type="button" onclick={back} disabled={busy}>Back</button>
        </div>
      {/if}
    </div>
  </div>
</div>
