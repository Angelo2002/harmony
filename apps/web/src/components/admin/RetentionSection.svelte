<script lang="ts">
  import { onMount } from 'svelte';
  import type { RetentionResponse, RetentionRunResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { formatBytes } from '../../lib/format';

  const GB = 1024 ** 3;

  let imageDays = $state('');
  let messageDays = $state('');
  let auditDays = $state('');
  let limitGb = $state('');
  let targetGb = $state('');
  let usage = $state<RetentionResponse['usage'] | null>(null);
  let lastRun = $state<RetentionResponse['lastRun']>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  function apply(data: RetentionResponse): void {
    imageDays = data.settings.imageRetentionDays == null ? '' : String(data.settings.imageRetentionDays);
    messageDays = data.settings.messageRetentionDays == null ? '' : String(data.settings.messageRetentionDays);
    auditDays = data.settings.auditRetentionDays == null ? '' : String(data.settings.auditRetentionDays);
    limitGb = data.settings.storageLimitBytes == null ? '' : String(round2(data.settings.storageLimitBytes / GB));
    targetGb = data.settings.storageTargetBytes == null ? '' : String(round2(data.settings.storageTargetBytes / GB));
    usage = data.usage;
    lastRun = data.lastRun;
  }

  function toDays(value: string): number | null {
    const parsed = Number(value.trim());
    if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed);
  }

  function toBytes(value: string): number | null {
    const parsed = Number(value.trim());
    if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * GB);
  }

  onMount(() => {
    void api<RetentionResponse>('/retention')
      .then(apply)
      .catch((cause: unknown) => {
        error = cause instanceof ApiError ? cause.message : String(cause);
      });
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      apply(
        await api<RetentionResponse>('/retention', {
          method: 'PATCH',
          body: JSON.stringify({
            imageRetentionDays: toDays(imageDays),
            messageRetentionDays: toDays(messageDays),
            auditRetentionDays: toDays(auditDays),
            storageLimitBytes: toBytes(limitGb),
            storageTargetBytes: toBytes(targetGb),
          }),
        }),
      );
      message = 'Retention settings saved.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function runNow(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      await api<RetentionRunResponse>('/retention/run', { method: 'POST' });
      apply(await api<RetentionResponse>('/retention'));
      message = 'Pruning finished.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Retention</h3>
  <p class="muted">Leave a field blank to keep that content forever.</p>

  <form onsubmit={save}>
    <label>
      Delete images after (days)
      <input bind:value={imageDays} placeholder="off" inputmode="numeric" />
    </label>

    <label>
      Delete messages after (days)
      <input bind:value={messageDays} placeholder="off" inputmode="numeric" />
    </label>

    <label>
      Delete log entries after (days)
      <input bind:value={auditDays} placeholder="off" inputmode="numeric" />
    </label>

    <label>
      Emergency clean-up when media exceeds (GB)
      <input bind:value={limitGb} placeholder="off" inputmode="decimal" />
    </label>

    <label>
      …and delete oldest content down to (GB)
      <input bind:value={targetGb} placeholder="same as above" inputmode="decimal" />
    </label>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <div class="editor-actions">
      <button type="submit" disabled={busy}>Save</button>
      <button type="button" onclick={runNow} disabled={busy}>Run clean-up now</button>
    </div>
  </form>

  {#if usage}
    <div class="panel">
      <h2>Stored</h2>
      <p>
        {formatBytes(usage.blobBytes)} of media · {usage.attachmentCount} attachment(s) ·
        {usage.messageCount} message(s)
      </p>
      {#if lastRun}
        <p class="muted">
          Last clean-up {new Date(lastRun.ranAt).toLocaleString()}: {lastRun.deletedAttachments} attachment(s),
          {lastRun.deletedMessages} message(s), {lastRun.deletedAuditEntries} log entry/entries,
          {lastRun.deletedBlobs} file(s) — freed
          {formatBytes(lastRun.freedBytes)}.
        </p>
      {:else}
        <p class="muted">No clean-up has run yet this session.</p>
      {/if}
    </div>
  {/if}
</section>
