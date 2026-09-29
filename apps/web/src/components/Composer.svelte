<script lang="ts">
  import { ALLOWED_IMAGE_TYPES, LIMITS, type Attachment, type Emoji } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { emojis } from '../lib/emojis.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');
  const maxAttachments = LIMITS.attachmentsPerMessage;

  let value = $state('');
  let busy = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let pending = $state<Attachment[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let showPicker = $state(false);

  async function onFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // allow picking the same file again later
    if (files.length === 0) return;

    error = null;
    uploading = true;
    try {
      for (const file of files) {
        if (pending.length >= maxAttachments) break;
        const form = new FormData();
        form.append('file', file);
        const attachment = await api<Attachment>('/attachments', { method: 'POST', body: form });
        pending = [...pending, attachment];
      }
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      uploading = false;
    }
  }

  function removePending(id: string): void {
    pending = pending.filter((attachment) => attachment.id !== id);
  }

  function insertEmoji(emoji: Emoji): void {
    const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
    value = `${value}${separator}:${emoji.name}:`;
    showPicker = false;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const content = value.trim();
    if (busy || uploading) return;
    if (!content && pending.length === 0) return;

    busy = true;
    error = null;
    try {
      await chat.sendMessage(
        content,
        pending.map((attachment) => attachment.id),
      );
      value = '';
      pending = [];
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="composer">
  {#if error}
    <p class="form-error">{error}</p>
  {/if}

  {#if showPicker}
    <div class="emoji-picker">
      {#if emojis.list.length === 0}
        <p class="muted">No custom emojis yet.</p>
      {:else}
        {#each emojis.list as emoji (emoji.id)}
          <button type="button" class="emoji-option" title={`:${emoji.name}:`} onclick={() => insertEmoji(emoji)}>
            <img src={`/api/v1/emojis/${emoji.id}`} alt={emoji.name} />
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if pending.length > 0}
    <div class="pending">
      {#each pending as attachment (attachment.id)}
        <div class="pending-item">
          <img src={`/api/v1/attachments/${attachment.id}`} alt={attachment.filename} />
          <button type="button" class="remove" title="Remove" onclick={() => removePending(attachment.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}

  <form onsubmit={submit}>
    <button type="button" class="attach" title="Add emoji" onclick={() => (showPicker = !showPicker)}>☺</button>
    <button type="button" class="attach" title="Attach image" disabled={uploading} onclick={() => fileInput?.click()}>
      {uploading ? '…' : '+'}
    </button>
    <input class="file-input" type="file" accept={acceptAttribute} multiple bind:this={fileInput} onchange={onFiles} />
    <input
      class="text-input"
      bind:value
      placeholder={`Message #${chat.activeChannel?.name ?? ''}`}
      autocomplete="off"
      aria-label="Message"
    />
    <button type="submit" disabled={busy || uploading}>Send</button>
  </form>
</div>
