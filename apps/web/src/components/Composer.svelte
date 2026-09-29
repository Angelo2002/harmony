<script lang="ts">
  import { tick } from 'svelte';
  import { ALLOWED_IMAGE_TYPES, LIMITS, type Attachment, type Emoji } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { emojis } from '../lib/emojis.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');
  const maxAttachments = LIMITS.attachmentsPerMessage;
  /** How many matches the `:emoji` autocomplete offers at once. */
  const maxSuggestions = 8;

  let value = $state('');
  let busy = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let pending = $state<Attachment[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let textInput = $state<HTMLInputElement | null>(null);
  let showPicker = $state(false);

  /** The `:emoji` fragment being typed at the caret, if any. */
  let activeQuery = $state<{ start: number; query: string } | null>(null);
  let highlight = $state(0);

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

  const replyName = $derived(
    chat.replyTarget?.author?.displayName ?? chat.replyTarget?.author?.username ?? 'Unknown',
  );

  /**
   * Finds a `:name` fragment ending at the caret, delimited by the start of the
   * line or whitespace, the way Discord triggers its emoji autocomplete.
   */
  function detectQuery(text: string, caret: number): { start: number; query: string } | null {
    const before = text.slice(0, caret);
    const match = /(?:^|\s):([a-zA-Z0-9_]{0,32})$/.exec(before);
    if (!match) return null;
    const name = match[1] ?? '';
    return { start: caret - name.length - 1, query: name };
  }

  function updateAutocomplete(): void {
    const input = textInput;
    if (!input) {
      activeQuery = null;
      return;
    }

    const caret = input.selectionStart ?? input.value.length;
    const next = detectQuery(input.value, caret);
    // Reset the selection whenever the query itself changes.
    if (next?.start !== activeQuery?.start || next?.query !== activeQuery?.query) highlight = 0;
    activeQuery = next;
  }

  const suggestions = $derived.by(() => {
    const query = activeQuery;
    if (!query) return [];

    const byName = [...emojis.list].sort((a, b) => a.name.localeCompare(b.name));
    const needle = query.query.toLowerCase();
    const prefix = byName.filter((emoji) => emoji.name.toLowerCase().startsWith(needle));
    const rest = needle
      ? byName.filter(
          (emoji) => !emoji.name.toLowerCase().startsWith(needle) && emoji.name.toLowerCase().includes(needle),
        )
      : [];
    return [...prefix, ...rest].slice(0, maxSuggestions);
  });

  async function acceptSuggestion(emoji: Emoji): Promise<void> {
    const input = textInput;
    const query = activeQuery;
    if (!input || !query) return;

    const caret = input.selectionStart ?? input.value.length;
    const inserted = `:${emoji.name}: `;
    value = `${input.value.slice(0, query.start)}${inserted}${input.value.slice(caret)}`;
    activeQuery = null;

    await tick();
    const position = query.start + inserted.length;
    input.focus();
    input.setSelectionRange(position, position);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlight = (highlight + 1) % suggestions.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlight = (highlight - 1 + suggestions.length) % suggestions.length;
        return;
      }
      // Enter and Tab accept the highlighted emoji instead of sending the message.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = suggestions[highlight];
        if (chosen) void acceptSuggestion(chosen);
        return;
      }
    }

    if (event.key === 'Escape') {
      if (activeQuery) {
        event.preventDefault();
        activeQuery = null;
        return;
      }
      if (chat.replyTarget) {
        event.preventDefault();
        chat.replyTarget = null;
      }
    }
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
        chat.replyTarget?.id ?? null,
      );
      value = '';
      pending = [];
      chat.replyTarget = null;
      activeQuery = null;
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

  {#if chat.replyTarget}
    <div class="replying">
      <span class="muted">Replying to <strong>{replyName}</strong></span>
      <button type="button" class="remove-reply" title="Cancel reply" onclick={() => (chat.replyTarget = null)}>×</button>
    </div>
  {/if}

  {#if suggestions.length > 0}
    <ul class="autocomplete" role="listbox" aria-label="Emoji suggestions">
      {#each suggestions as emoji, index (emoji.id)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            class="autocomplete-item"
            class:active={index === highlight}
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => acceptSuggestion(emoji)}
            onmouseenter={() => (highlight = index)}
          >
            <img src={`/api/v1/emojis/${emoji.id}`} alt="" />
            <span class="autocomplete-name">:{emoji.name}:</span>
          </button>
        </li>
      {/each}
    </ul>
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
      bind:this={textInput}
      placeholder={`Message #${chat.activeChannel?.name ?? ''}`}
      autocomplete="off"
      aria-label="Message"
      aria-autocomplete="list"
      oninput={updateAutocomplete}
      onkeydown={onKeydown}
      onclick={updateAutocomplete}
      onkeyup={updateAutocomplete}
      onfocus={updateAutocomplete}
      onblur={() => (activeQuery = null)}
    />
    <button type="submit" disabled={busy || uploading}>Send</button>
  </form>
</div>
