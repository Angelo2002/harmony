<script lang="ts">
  import { onMount } from 'svelte';
  import type { Channel, ChannelExportFormat, ChannelListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { session } from '../../lib/session.svelte';

  /**
   * How long a download button stays disabled after a click. Both downloads are
   * plain links, so the browser streams the file to disk and shows its progress
   * itself; the page never learns when one starts or ends. A short pause is
   * enough to stop a double click from asking the server for two at once.
   */
  const PREPARING_MS = 4000;

  const isOwner = $derived(session.user?.isOwner === true);

  let channels = $state<Channel[]>([]);
  let channelId = $state('');
  let format = $state<ChannelExportFormat>('html');
  let preparingBackup = $state(false);
  let preparingExport = $state(false);
  let error = $state<string | null>(null);

  const exportHref = $derived(
    channelId ? `/api/v1/channels/${encodeURIComponent(channelId)}/export?format=${format}` : null,
  );

  onMount(() => {
    void api<ChannelListResponse>('/channels')
      .then((data) => {
        channels = data.channels;
        channelId = data.channels[0]?.id ?? '';
      })
      .catch((cause: unknown) => {
        error = cause instanceof ApiError ? cause.message : String(cause);
      });
  });

  /**
   * Swaps the link for a disabled button. Deferred a tick so the link is still
   * on the page when the browser acts on the click that started the download.
   */
  function pause(set: (value: boolean) => void): void {
    setTimeout(() => {
      set(true);
      setTimeout(() => set(false), PREPARING_MS);
    });
  }
</script>

<section>
  <h3>Backup</h3>

  {#if isOwner}
    <div class="panel">
      <h2>Full backup</h2>
      <p class="muted">
        One <code>.tar.gz</code> holding a consistent copy of the database and every uploaded file: all
        messages, members, roles, channels, settings and media. It is laid out like the data directory,
        so restoring means stopping the server and extracting it there (see the deployment guide).
      </p>
      <div class="status err">
        <strong>This file is sensitive.</strong> It contains every member's password hash, the Discord bot
        token and sign-in secret, and messages from locked channels and deleted messages. Store it somewhere
        only you can read.
      </div>
      <div class="editor-actions">
        {#if preparingBackup}
          <button type="button" disabled>Preparing backup…</button>
        {:else}
          <a class="button-link" href="/api/v1/backup" download onclick={() => pause((value) => (preparingBackup = value))}>
            Download backup
          </a>
        {/if}
      </div>
      {#if preparingBackup}
        <p class="muted">Your browser shows the download's progress. Large instances take a while.</p>
      {/if}
    </div>
  {:else}
    <p class="muted">
      Only the owner can download a full backup, since it contains every account's password hash.
    </p>
  {/if}

  <div class="panel">
    <h2>Export a channel</h2>
    <p class="muted">
      A channel's history with author names, timestamps, edits, replies, reactions and links to its
      attachments (the files themselves stay on the server). HTML is a page to read in any browser; JSON is
      for other tools. Deleted messages are left out.
    </p>
    {#if error}<p class="form-error">{error}</p>{/if}
    <div class="inline">
      <select bind:value={channelId} aria-label="Channel">
        {#each channels as channel (channel.id)}
          <option value={channel.id}>#{channel.name}</option>
        {/each}
      </select>
      <select bind:value={format} aria-label="Format">
        <option value="html">HTML page</option>
        <option value="json">JSON</option>
      </select>
      {#if preparingExport || !exportHref}
        <button type="button" disabled>{preparingExport ? 'Exporting…' : 'Export'}</button>
      {:else}
        <a class="button-link" href={exportHref} download onclick={() => pause((value) => (preparingExport = value))}>
          Export
        </a>
      {/if}
    </div>
  </div>
</section>
