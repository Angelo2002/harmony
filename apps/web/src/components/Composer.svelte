<script lang="ts">
  import { tick } from 'svelte';
  import {
    ALLOWED_ATTACHMENT_TYPES,
    LIMITS,
    bypassesSlowmode,
    formatSlowmode,
    isTimedOut,
    type Attachment,
    type User,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { emojis } from '../lib/emojis.svelte';
  import { mediaFilesFrom } from '../lib/files';
  import { members } from '../lib/members.svelte';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import { uploads } from '../lib/upload-queue.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import GifPicker from './GifPicker.svelte';
  import Icon from './Icon.svelte';

  const acceptAttribute = ALLOWED_ATTACHMENT_TYPES.join(',');
  const maxAttachments = LIMITS.attachmentsPerMessage;
  /** How many matches any autocomplete offers at once. */
  const maxSuggestions = 8;
  /** How stale the member directory may be before a mention refreshes it. */
  const directoryMaxAgeMs = 30_000;

  let value = $state('');
  let busy = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let pending = $state<Attachment[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let textInput = $state<HTMLInputElement | null>(null);
  let showPicker = $state(false);
  let showGifs = $state(false);

  /** The `:emoji` or `@mention` fragment being typed at the caret, if any. */
  let activeTrigger = $state<Trigger | null>(null);
  let highlight = $state(0);

  type Trigger =
    | { kind: 'emoji'; start: number; query: string }
    | { kind: 'mention'; start: number; query: string }
    | { kind: 'channel'; start: number; query: string };

  /** One row in the autocomplete popup, whichever kind it is. */
  interface Suggestion {
    key: string;
    label: string;
    detail: string | null;
    imageUrl: string | null;
    initial: string | null;
    /** The text inserted when the row is accepted. */
    insert: string;
  }

  /** A client-side size check, so an oversized file is refused before uploading. */
  function tooLarge(file: File): string | null {
    const isVideo = file.type.startsWith('video/');
    const limit = isVideo ? meta.data?.maxVideoBytes : meta.data?.maxImageBytes;
    if (!limit || file.size <= limit) return null;
    const kind = isVideo ? 'videos' : 'images';
    return `${file.name} is too large — ${kind} are at most ${Math.round(limit / (1024 * 1024))} MB.`;
  }

  /** Uploads each file and queues it on the message being written. */
  async function uploadFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    error = null;
    uploading = true;
    try {
      for (const file of files) {
        if (pending.length >= maxAttachments) {
          error = `You can attach at most ${maxAttachments} files per message.`;
          break;
        }
        const rejection = tooLarge(file);
        if (rejection) {
          error = rejection;
          continue;
        }
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

  async function onFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // allow picking the same file again later
    await uploadFiles(files);
  }

  /** Pasted screenshots become attachments, the way Discord does it. */
  function onPaste(event: ClipboardEvent): void {
    if (timeoutUntil !== null) return;
    const files = mediaFilesFrom(event.clipboardData);
    if (files.length === 0) return;
    // Only swallow the paste when there are images to take from it.
    event.preventDefault();
    void uploadFiles(files);
  }

  /** Uploads whatever was dropped on the chat pane, handed over by the queue. */
  $effect(() => {
    if (uploads.count === 0) return;
    void uploadFiles(uploads.take());
  });

  function removePending(id: string): void {
    pending = pending.filter((attachment) => attachment.id !== id);
  }

  /**
   * Queues whatever the gif picker chose. Picking already stored the gif as an
   * unattached attachment of this member's, so from here it is no different from
   * an upload that has just finished.
   */
  function addGif(attachment: Attachment): void {
    showGifs = false;
    if (pending.length >= maxAttachments) {
      error = `You can attach at most ${maxAttachments} files per message.`;
      return;
    }
    error = null;
    pending = [...pending, attachment];
  }

  /**
   * Inserts whatever the picker chose. A server emoji arrives as its `:name:`
   * shortcode and a unicode one as the character itself, so either way the text
   * is what goes in the field.
   */
  function insertEmoji(emoji: string): void {
    const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
    value = `${value}${separator}${emoji}`;
    showPicker = false;
  }

  const replyName = $derived(
    chat.replyTarget?.author?.displayName ?? chat.replyTarget?.author?.username ?? 'Deleted user',
  );

  /** When the current user is timed out, the composer is locked with a note. */
  const timeoutUntil = $derived(
    session.user && isTimedOut(session.user) && session.user.timedOutUntil
      ? new Date(session.user.timedOutUntil).toLocaleString()
      : null,
  );

  const permissions = $derived(BigInt(session.permissions || '0'));
  const slowmodeSeconds = $derived(chat.activeChannel?.slowmodeSeconds ?? 0);
  /** Slowmode that applies to this member here; moderators skip it. */
  const slowmodeApplies = $derived(slowmodeSeconds > 0 && !bypassesSlowmode(permissions));

  /*
   * A local countdown started after a successful post so the wait is visible
   * without another round trip. The server is still the authority, and its own
   * refusal starts the same countdown, so a second tab stays honest.
   */
  let cooldownChannelId = $state<string | null>(null);
  let cooldownEndsAt = $state(0);
  let clock = $state(Date.now());

  $effect(() => {
    if (cooldownEndsAt <= 0) return;
    const timer = setInterval(() => {
      clock = Date.now();
      if (clock >= cooldownEndsAt) {
        clearInterval(timer);
        cooldownEndsAt = 0;
      }
    }, 250);
    return () => clearInterval(timer);
  });

  /** Seconds left before this member may post here again; 0 when they may. */
  const slowmodeRemaining = $derived(
    cooldownChannelId === chat.activeChannelId && cooldownEndsAt > clock
      ? Math.ceil((cooldownEndsAt - clock) / 1000)
      : 0,
  );

  function startSlowmodeCooldown(): void {
    if (!slowmodeApplies) return;
    cooldownChannelId = chat.activeChannelId;
    cooldownEndsAt = Date.now() + slowmodeSeconds * 1000;
    clock = Date.now();
  }

  /** At most one typing ping per burst window while the box has text. */
  const typingThrottleMs = 5000;
  let lastTypingAt = 0;

  /**
   * Announces typing to the server, throttled so a fast typist does not trip the
   * limiter. Clearing the box resets the throttle so the next burst is immediate.
   */
  function maybeSendTyping(text: string): void {
    if (!session.user?.showTyping || timeoutUntil !== null || !chat.activeChannelId) return;
    if (text.trim().length === 0) {
      lastTypingAt = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTypingAt < typingThrottleMs) return;
    lastTypingAt = now;
    void chat.sendTyping();
  }

  function onInput(): void {
    updateAutocomplete();
    // Read the element rather than `value`, so we never depend on binding order.
    maybeSendTyping(textInput?.value ?? '');
  }

  /**
   * Finds the `:name` or `@name` fragment ending at the caret, delimited by the
   * start of the line or whitespace, the way Discord triggers autocomplete.
   */
  function detectTrigger(text: string, caret: number): Trigger | null {
    const before = text.slice(0, caret);

    const emoji = /(?:^|\s):([a-zA-Z0-9_]{0,32})$/.exec(before);
    if (emoji) {
      const query = emoji[1] ?? '';
      return { kind: 'emoji', start: caret - query.length - 1, query };
    }

    const mention = /(?:^|\s)@([a-zA-Z0-9._-]{0,32})$/.exec(before);
    if (mention) {
      const query = mention[1] ?? '';
      return { kind: 'mention', start: caret - query.length - 1, query };
    }

    // A channel name may contain a space, but the query stops at one: typing
    // `#off` offers `Off Topic` rather than trying to pass the space through.
    const channel = /(?:^|\s)#([^\s#]{0,63})$/.exec(before);
    if (channel) {
      const query = channel[1] ?? '';
      return { kind: 'channel', start: caret - query.length - 1, query };
    }

    return null;
  }

  function updateAutocomplete(): void {
    const input = textInput;
    if (!input) {
      activeTrigger = null;
      return;
    }

    const caret = input.selectionStart ?? input.value.length;
    const next = detectTrigger(input.value, caret);
    // Reset the selection whenever the fragment being typed changes.
    if (
      next?.kind !== activeTrigger?.kind ||
      next?.start !== activeTrigger?.start ||
      next?.query !== activeTrigger?.query
    ) {
      highlight = 0;
    }
    // Refresh the directory as we open a mention, in case someone just joined.
    if (next?.kind === 'mention' && activeTrigger?.kind !== 'mention') {
      void members.refreshIfStale(directoryMaxAgeMs);
    }
    activeTrigger = next;
  }

  /** Ranks a member: 0 for a prefix match, 1 for a substring, 2 for no match. */
  function rankMember(user: User, needle: string): number {
    const username = user.username.toLowerCase();
    const display = (user.displayName ?? '').toLowerCase();
    if (username.startsWith(needle) || display.startsWith(needle)) return 0;
    if (username.includes(needle) || display.includes(needle)) return 1;
    return 2;
  }

  /**
   * Who can actually be mentioned here. Discord stand-in accounts only exist to
   * represent people on the other side of a bridged channel, so they are hidden
   * in every other channel: a mention there could never reach them.
   */
  const mentionableUsers = $derived.by((): User[] => {
    if (chat.activeChannel?.discordChannelId != null) return members.list;
    return members.list.filter((user) => !user.isBot);
  });

  const suggestions = $derived.by((): Suggestion[] => {
    const trigger = activeTrigger;
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();

    if (trigger.kind === 'emoji') {
      const byName = [...emojis.picker].sort((a, b) => a.name.localeCompare(b.name));
      const prefix = byName.filter((emoji) => emoji.name.toLowerCase().startsWith(needle));
      const rest = needle
        ? byName.filter(
            (emoji) => !emoji.name.toLowerCase().startsWith(needle) && emoji.name.toLowerCase().includes(needle),
          )
        : [];
      return [...prefix, ...rest].slice(0, maxSuggestions).map((emoji) => ({
        key: `emoji:${emoji.id}`,
        label: `:${emoji.name}:`,
        detail: null,
        imageUrl: `/api/v1/emojis/${emoji.id}`,
        initial: null,
        insert: `:${emoji.name}: `,
      }));
    }

    if (trigger.kind === 'channel') {
      const matches = chat.channels
        .filter((channel) => channel.name.toLowerCase().includes(needle))
        .sort((a, b) => {
          const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
          const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
          return aPrefix - bPrefix || a.name.localeCompare(b.name);
        })
        .slice(0, maxSuggestions);
      return matches.map((channel) => ({
        key: `channel:${channel.id}`,
        label: `#${channel.name}`,
        detail: null,
        imageUrl: null,
        initial: null,
        insert: `#${channel.name} `,
      }));
    }

    return mentionableUsers
      .map((user) => ({ user, rank: rankMember(user, needle) }))
      .filter((entry) => entry.rank < 2)
      .sort((a, b) => a.rank - b.rank || a.user.username.localeCompare(b.user.username))
      .slice(0, maxSuggestions)
      .map(({ user }) => ({
        key: `mention:${user.id}`,
        label: user.displayName ?? user.username,
        detail: `@${user.username}`,
        imageUrl: avatarUrl(user),
        initial: initial(user),
        insert: `@${user.username} `,
      }));
  });

  async function acceptSuggestion(suggestion: Suggestion): Promise<void> {
    const input = textInput;
    const trigger = activeTrigger;
    if (!input || !trigger) return;

    const caret = input.selectionStart ?? input.value.length;
    value = `${input.value.slice(0, trigger.start)}${suggestion.insert}${input.value.slice(caret)}`;
    activeTrigger = null;

    await tick();
    const position = trigger.start + suggestion.insert.length;
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
      // Tab accepts the highlighted suggestion, the way Discord does. Enter is
      // deliberately left alone so that it sends the message: otherwise somebody
      // typing an emoticon like :D or :3 gets an emoji they did not ask for
      // instead of their message, since a : starts the same list either way.
      if (event.key === 'Tab') {
        event.preventDefault();
        const chosen = suggestions[highlight];
        if (chosen) void acceptSuggestion(chosen);
        return;
      }
    }

    if (event.key === 'Escape') {
      if (activeTrigger) {
        event.preventDefault();
        activeTrigger = null;
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
    if (busy || uploading || timeoutUntil !== null || slowmodeRemaining > 0) return;
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
      activeTrigger = null;
      startSlowmodeCooldown();
    } catch (cause) {
      // The server refused for slowmode: honor it even if this tab had not
      // started its own countdown, e.g. the first post after a reload.
      if (cause instanceof ApiError && cause.code === 'slowmode') startSlowmodeCooldown();
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="composer" onpaste={onPaste}>
  {#if error}
    <p class="form-error">{error}</p>
  {/if}

  {#if timeoutUntil}
    <p class="form-error">You are timed out until {timeoutUntil}. You can still read along.</p>
  {/if}

  {#if slowmodeRemaining > 0}
    <p class="muted">Slowmode: you can post again in {slowmodeRemaining}s.</p>
  {:else if slowmodeApplies}
    <p class="muted">Slowmode is on: one message every {formatSlowmode(slowmodeSeconds)}.</p>
  {/if}

  {#if showPicker}
    <EmojiPicker onpick={(emoji) => insertEmoji(emoji)} />
  {/if}

  {#if showGifs}
    <GifPicker onpick={addGif} />
  {/if}

  {#if pending.length > 0}
    <div class="pending">
      {#each pending as attachment (attachment.id)}
        <div class="pending-item">
          {#if attachment.contentType.startsWith('video/')}
            <!-- A short silent preview; there is no caption track to attach. -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={`/api/v1/attachments/${attachment.id}`} muted preload="metadata"></video>
          {:else}
            <img src={`/api/v1/attachments/${attachment.id}`} alt={attachment.filename} />
          {/if}
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
    <ul class="autocomplete" role="listbox" aria-label="Suggestions">
      {#each suggestions as suggestion, index (suggestion.key)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            class="autocomplete-item"
            class:active={index === highlight}
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => acceptSuggestion(suggestion)}
            onmouseenter={() => (highlight = index)}
          >
            {#if suggestion.imageUrl}
              <img class="autocomplete-image" src={suggestion.imageUrl} alt="" />
            {:else if suggestion.initial}
              <span class="autocomplete-initial">{suggestion.initial}</span>
            {/if}
            <span class="autocomplete-name">{suggestion.label}</span>
            {#if suggestion.detail}<span class="autocomplete-detail">{suggestion.detail}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <form onsubmit={submit}>
    <button
      type="button"
      class="attach"
      title="Add emoji"
      aria-label="Add emoji"
      onclick={() => {
        showPicker = !showPicker;
        showGifs = false;
      }}><Icon name="smile" size={20} /></button
    >
    <button
      type="button"
      class="attach attach-gif"
      title="Add gif"
      aria-label="Add gif"
      onclick={() => {
        showGifs = !showGifs;
        showPicker = false;
      }}>GIF</button>
    <button
      type="button"
      class="attach"
      title="Attach image"
      aria-label="Attach image"
      disabled={uploading || timeoutUntil !== null}
      onclick={() => fileInput?.click()}
    >
      {#if uploading}…{:else}<Icon name="paperclip" size={20} />{/if}
    </button>
    <input class="file-input" type="file" accept={acceptAttribute} multiple bind:this={fileInput} onchange={onFiles} />
    <input
      class="text-input"
      type="search"
      bind:value
      bind:this={textInput}
      placeholder={`Message #${chat.activeChannel?.name ?? ''}`}
      autocomplete="off"
      autocorrect="off"
      enterkeyhint="send"
      aria-label="Message"
      aria-autocomplete="list"
      disabled={timeoutUntil !== null || slowmodeRemaining > 0}
      oninput={onInput}
      onkeydown={onKeydown}
      onclick={updateAutocomplete}
      onkeyup={updateAutocomplete}
      onfocus={updateAutocomplete}
      onblur={() => (activeTrigger = null)}
    />
    <button type="submit" disabled={busy || uploading || timeoutUntil !== null || slowmodeRemaining > 0}>Send</button>
  </form>
</div>
