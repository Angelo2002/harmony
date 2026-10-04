<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiErrorBody, Channel, ChannelExportFormat, ChannelListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { session } from '../../lib/session.svelte';

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
   * Fetches a download and hands the bytes to the browser as a file. Routing it
   * through fetch instead of a plain link is what keeps a failure inside the
   * app: a link answered with 409 or 403 navigates away and shows the raw error
   * body, while this reports the message in the panel. The archive is held in
   * memory before it is saved, which is fine at the size one community produces.
   */
  async function saveFile(path: string): Promise<void> {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) {
      let message = 'The download failed.';
      try {
        const body = (await response.json()) as ApiErrorBody;
        message = body?.error?.message ?? message;
      } catch {
        // A body that is not our error JSON leaves the generic message.
      }
      throw new ApiError(response.status, 'download_failed', message);
    }

    const disposition = response.headers.get('Content-Disposition') ?? '';
    const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? 'download';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoke on the next task, so the click still has its moment to start the save.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function downloadBackup(): Promise<void> {
    error = null;
    preparingBackup = true;
    try {
      await saveFile('/api/v1/backup');
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      preparingBackup = false;
    }
  }

  async function downloadExport(): Promise<void> {
    if (!exportHref) return;
    error = null;
    preparingExport = true;
    try {
      await saveFile(exportHref);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      preparingExport = false;
    }
  }
</script>

<section>
  <h3>Backup</h3>

  {#if error}<p class="form-error">{error}</p>{/if}

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
        <button type="button" class="primary" disabled={preparingBackup} onclick={downloadBackup}>
          {preparingBackup ? 'Preparing backup…' : 'Download backup'}
        </button>
      </div>
      {#if preparingBackup}
        <p class="muted">The archive is built and held in the browser before it is saved. Large instances take a while.</p>
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
      <button type="button" class="primary" disabled={preparingExport || !exportHref} onclick={downloadExport}>
        {preparingExport ? 'Exporting…' : 'Export'}
      </button>
    </div>
  </div>
</section>
