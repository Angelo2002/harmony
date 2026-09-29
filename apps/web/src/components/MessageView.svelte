<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Permission, hasPermission, type Message, type User } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { avatarUrl, initial } from '../lib/avatar';
  import { parseMessage, type InlineSegment } from '../lib/message-text';
  import { emojis } from '../lib/emojis.svelte';
  import { members } from '../lib/members.svelte';
  import { profileCard } from '../lib/profile-card.svelte';
  import { session } from '../lib/session.svelte';
  import EmojiPicker from './EmojiPicker.svelte';

  /** Opens the profile card for an author, when there is one to show. */
  function openCard(user: User | null | undefined, element: HTMLElement): void {
    if (user) profileCard.show(user, element);
  }

  let scroller = $state<HTMLDivElement | null>(null);
  /** Whether the view is still pinned to the newest message. */
  let atBottom = $state(true);
  /** Ids of the first and last rendered messages, to tell appends from prepends. */
  let firstId: string | null = null;
  let lastId: string | null = null;
  let watchedChannelId: string | null = null;
  /** The message whose reaction picker is open, if any. */
  let pickerFor = $state<string | null>(null);
  /** The message currently being edited, and its draft text. */
  let editingId = $state<string | null>(null);
  let editValue = $state('');
  /** The message whose delete is awaiting confirmation. */
  let confirmingDeleteId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  /** The message whose action menu is open on touch, or null. */
  let actionsFor = $state<string | null>(null);
  /** How long a finger must rest on a message before its menu opens. */
  const longPressMs = 450;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressOrigin = { x: 0, y: 0 };
  let pressId: string | null = null;
  /** The kind of pointer last seen, so a touch long press can hide the browser menu. */
  let lastPointerType = 'mouse';

  const myId = $derived(session.user?.id);
  const permissions = $derived(BigInt(session.permissions || '0'));

  // Custom emoji that can actually be rendered; deleted ones fall back to text.
  const knownEmojiIds = $derived(new Set(emojis.list.map((emoji) => emoji.id)));

  /** Consecutive messages from one author within this window are grouped. */
  const groupingWindowMs = 7 * 60 * 1000;

  /**
   * Whether a message continues the previous one: same author, close in time,
   * and not a reply (a reply always shows its own header, like Discord).
   */
  function isGrouped(previous: Message | undefined, message: Message): boolean {
    if (!previous?.author || !message.author) return false;
    if (message.replyTo) return false;
    if (previous.author.id !== message.author.id) return false;
    const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= groupingWindowMs;
  }

  /**
   * Messages paired with whether they continue the previous one. Computed in one
   * place rather than per row, so the flag is always evaluated against the whole
   * list and cannot go stale as messages arrive.
   */
  const rows = $derived.by(() =>
    chat.messages.map((message, index) => ({
      message,
      grouped: isGrouped(index > 0 ? chat.messages[index - 1] : undefined, message),
    })),
  );

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Unknown';
  }

  function replyAuthorName(message: Message): string {
    const author = message.replyTo?.author;
    return author?.displayName ?? author?.username ?? 'Unknown';
  }

  function replySnippet(message: Message): string {
    if (message.replyTo?.deleted) return 'original message was deleted';
    return message.replyTo?.content.replace(/\s+/g, ' ').trim() ?? '';
  }

  // Only the author may edit; the author or any message manager may delete.
  function canEdit(message: Message): boolean {
    return message.author?.id === myId;
  }
  function canDelete(message: Message): boolean {
    return message.author?.id === myId || hasPermission(permissions, Permission.ManageMessages);
  }

  function pickReaction(message: Message, emoji: string, emojiId: string | null): void {
    pickerFor = null;
    void chat.toggleReaction(message.id, emoji, emojiId);
  }

  function startEdit(message: Message): void {
    actionError = null;
    editingId = message.id;
    editValue = message.content;
  }

  async function saveEdit(event: SubmitEvent, message: Message): Promise<void> {
    event.preventDefault();
    const content = editValue.trim();
    if (!content) return;
    actionError = null;
    try {
      await chat.editMessage(message.id, content);
      editingId = null;
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  async function remove(message: Message): Promise<void> {
    actionError = null;
    try {
      await chat.deleteMessage(message.id);
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      confirmingDeleteId = null;
    }
  }

  function onScroll(): void {
    const element = scroller;
    if (!element) return;
    atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    if (element.scrollTop < 80) void loadOlder();
  }

  function cancelLongPress(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressId = null;
  }

  /** A mouse reveals the menu on hover; a finger needs a long press instead. */
  function onMessagePointerDown(event: PointerEvent, message: Message): void {
    lastPointerType = event.pointerType;
    if (event.pointerType === 'mouse') return;
    cancelLongPress();
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressId = message.id;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (pressId !== message.id) return;
      // A long press over a name/avatar would otherwise open its profile card
      // at the same moment as the menu.
      (document.activeElement as HTMLElement | null)?.blur();
      profileCard.hide();
      actionsFor = message.id;
    }, longPressMs);
  }

  /** Scrolling or dragging the list must not count as a press. */
  function onMessagePointerMove(event: PointerEvent): void {
    if (pressTimer === null) return;
    const dx = event.clientX - pressOrigin.x;
    const dy = event.clientY - pressOrigin.y;
    if (dx * dx + dy * dy > 100) cancelLongPress();
  }

  /** Suppresses the browser's own long-press menu, which would fight ours. */
  function onMessageContextMenu(event: MouseEvent): void {
    if (lastPointerType !== 'mouse') event.preventDefault();
  }

  onMount(() => {
    // Tapping anywhere except the menu itself dismisses it.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.message-actions')) return;
      actionsFor = null;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  // A channel change leaves any open menu pointing at the wrong list.
  $effect(() => {
    void chat.activeChannelId;
    actionsFor = null;
  });

  /** Loads an older page while holding the messages already on screen in place. */
  async function loadOlder(): Promise<void> {
    const element = scroller;
    if (!element) return;

    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    await chat.loadOlder();
    await tick();

    // The prepend made the list taller; keep the viewport over the same message.
    const grown = element.scrollHeight - previousHeight;
    if (grown > 0) element.scrollTop = previousTop + grown;
  }

  // Follow the newest message, but never yank the view when older pages load.
  $effect(() => {
    const element = scroller;
    const channelId = chat.activeChannelId;
    const newest = chat.messages.at(-1)?.id ?? null;
    const oldest = chat.messages[0]?.id ?? null;

    if (channelId !== watchedChannelId) {
      watchedChannelId = channelId;
      firstId = null;
      lastId = null;
    }

    const prepended = firstId !== null && oldest !== firstId;
    const previousNewest = lastId;
    firstId = oldest;
    lastId = newest;

    if (!element || prepended) return;
    if (newest !== null && newest !== previousNewest && (previousNewest === null || atBottom)) {
      element.scrollTo({ top: element.scrollHeight });
    }
  });
</script>

{#snippet inlineSegments(segments: InlineSegment[])}
  {#each segments as segment, index (index)}
    <span
      class="seg"
      class:bold={segment.styles?.bold}
      class:italic={segment.styles?.italic}
      class:underline={segment.styles?.underline}
      class:strike={segment.styles?.strike}
      class:spoiler={segment.styles?.spoiler}
    >
      {#if segment.type === 'emoji'}
        <img
          class="emoji"
          src={`/api/v1/emojis/${segment.emoji.id}`}
          alt={`:${segment.emoji.name}:`}
          title={`:${segment.emoji.name}:`}
        />
      {:else if segment.type === 'mention'}
        <button
          type="button"
          class="mention profile-trigger"
          title={`@${segment.user.username}`}
          onmouseenter={(event) => openCard(segment.user, event.currentTarget)}
          onmouseleave={() => profileCard.scheduleHide()}
          onfocus={(event) => openCard(segment.user, event.currentTarget)}
          onblur={() => profileCard.scheduleHide()}
        >
          @{segment.user.displayName ?? segment.user.username}
        </button>
      {:else if segment.type === 'link'}
        <a class="link" href={segment.href} target="_blank" rel="noreferrer noopener">{segment.value}</a>
      {:else if segment.type === 'code'}
        <code class="inline-code">{segment.value}</code>
      {:else}
        {segment.value}
      {/if}
    </span>
  {/each}
{/snippet}

<div class="messages" bind:this={scroller} onscroll={onScroll}>
  {#if actionError}
    <p class="form-error pad">{actionError}</p>
  {/if}

  {#if chat.loadingOlder}
    <p class="muted pad">Loading older messages…</p>
  {/if}

  {#if chat.loading}
    <p class="muted pad">Loading…</p>
  {:else if chat.messages.length === 0}
    <p class="muted pad">No messages yet. Say hello!</p>
  {:else}
    {#each rows as row (row.message.id)}
      {@const message = row.message}
      {@const grouped = row.grouped}
      {@const authorColor =
        message.author?.roleColor == null
          ? null
          : `#${message.author.roleColor.toString(16).padStart(6, '0')}`}
      {@const blocks = parseMessage(message.content, emojis.lookup, (name) =>
        members.byUsername.get(name.toLowerCase()),
      )}
      {@const mentionsMe = blocks.some(
        (block) =>
          block.type !== 'code' &&
          block.segments.some((segment) => segment.type === 'mention' && segment.user.id === myId),
      )}
      {@const picture = avatarUrl(message.author)}
      <article
        class="message"
        class:grouped
        class:mentions-me={mentionsMe}
        class:selected={chat.replyTarget?.id === message.id}
        class:actions-open={actionsFor === message.id}
        onpointerdown={(event) => onMessagePointerDown(event, message)}
        onpointermove={onMessagePointerMove}
        onpointerup={cancelLongPress}
        onpointercancel={cancelLongPress}
        onpointerleave={cancelLongPress}
        oncontextmenu={onMessageContextMenu}
      >
        {#if grouped}
          <div class="avatar-spacer" aria-hidden="true"><span class="gutter-time">{formatTime(message.createdAt)}</span></div>
        {:else if picture}
          <img
            class="avatar profile-trigger"
            src={picture}
            alt=""
            loading="lazy"
            onmouseenter={(event) => openCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
          />
        {:else}
          <button
            type="button"
            class="avatar fallback profile-trigger"
            aria-label={authorName(message)}
            onmouseenter={(event) => openCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
            onfocus={(event) => openCard(message.author, event.currentTarget)}
            onblur={() => profileCard.scheduleHide()}
            onclick={(event) => openCard(message.author, event.currentTarget)}
          >
            {initial(message.author)}
          </button>
        {/if}
        <div class="body">
          {#if message.replyTo}
            <div class="reply-ref" class:deleted={message.replyTo.deleted}>
              <span class="reply-author">{replyAuthorName(message)}</span>
              {#if replySnippet(message)}
                <span class="reply-text">{replySnippet(message)}</span>
              {/if}
            </div>
          {/if}

          {#if !grouped}
            <div class="meta">
              <button
                type="button"
                class="author profile-trigger"
                style={authorColor ? `color: ${authorColor}` : ''}
                onmouseenter={(event) => openCard(message.author, event.currentTarget)}
                onmouseleave={() => profileCard.scheduleHide()}
                onfocus={(event) => openCard(message.author, event.currentTarget)}
                onblur={() => profileCard.scheduleHide()}
              >
                {authorName(message)}
              </button>
              <time>{formatTime(message.createdAt)}</time>
              {#if message.editedAt}<span class="edited">(edited)</span>{/if}
            </div>
          {:else if message.editedAt}
            <span class="edited">(edited)</span>
          {/if}

          {#if editingId === message.id}
            <form class="edit-form" onsubmit={(event) => saveEdit(event, message)}>
              <textarea class="edit-box" bind:value={editValue} rows="3" aria-label="Edit message"></textarea>
              <div class="edit-actions">
                <button type="submit" disabled={!editValue.trim()}>Save</button>
                <button type="button" class="ghost" onclick={() => (editingId = null)}>Cancel</button>
              </div>
            </form>
          {:else}
            {#if message.content}
              <div class="content">
                {#each blocks as block, blockIndex (blockIndex)}
                  {#if block.type === 'code'}
                    <pre class="code-block"><code>{block.text}</code></pre>
                  {:else if block.type === 'quote'}
                    <blockquote class="quote">{@render inlineSegments(block.segments)}</blockquote>
                  {:else if block.type === 'header'}
                    <p class="md-header" class:md-h1={block.level === 1} class:md-h2={block.level === 2}>
                      {@render inlineSegments(block.segments)}
                    </p>
                  {:else}
                    <p class="paragraph">{@render inlineSegments(block.segments)}</p>
                  {/if}
                {/each}
              </div>
            {/if}

            {#if message.attachments.length > 0}
              <div class="attachments">
                {#each message.attachments as attachment (attachment.id)}
                  <a href={`/api/v1/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                    <img
                      src={`/api/v1/attachments/${attachment.id}`}
                      alt={attachment.filename}
                      width={attachment.width ?? undefined}
                      height={attachment.height ?? undefined}
                      loading="lazy"
                    />
                  </a>
                {/each}
              </div>
            {/if}

            {#if message.reactions.length > 0}
              <div class="reactions">
                {#each message.reactions as reaction (reaction.emoji)}
                  <button
                    type="button"
                    class="reaction"
                    class:me={reaction.me}
                    title={reaction.me ? 'Remove your reaction' : 'Add your reaction'}
                    onclick={() => pickReaction(message, reaction.emoji, reaction.emojiId)}
                  >
                    {#if reaction.emojiId && knownEmojiIds.has(reaction.emojiId)}
                      <img class="emoji" src={`/api/v1/emojis/${reaction.emojiId}`} alt={reaction.emoji} />
                    {:else}
                      <span class="reaction-emoji">{reaction.emoji}</span>
                    {/if}
                    <span class="reaction-count">{reaction.count}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if message.embed}
              <a class="embed" href={message.embed.url} target="_blank" rel="noreferrer noopener">
                {#if message.embed.siteName}<span class="embed-site">{message.embed.siteName}</span>{/if}
                {#if message.embed.title}<span class="embed-title">{message.embed.title}</span>{/if}
                {#if message.embed.description}
                  <span class="embed-description">{message.embed.description}</span>
                {/if}
              </a>
            {/if}
          {/if}

          {#if pickerFor === message.id}
            <EmojiPicker onpick={(emoji, emojiId) => pickReaction(message, emoji, emojiId)} />
          {/if}
        </div>

        <div class="message-actions" class:open={actionsFor === message.id}>
          <button
            type="button"
            title="Reply"
            onclick={() => {
              chat.replyTarget = message;
              actionsFor = null;
            }}>Reply</button
          >
          <button
            type="button"
            title="Add reaction"
            onclick={() => {
              pickerFor = pickerFor === message.id ? null : message.id;
              actionsFor = null;
            }}
          >
            React
          </button>
          {#if canEdit(message)}
            <button
              type="button"
              title="Edit"
              onclick={() => {
                startEdit(message);
                actionsFor = null;
              }}>Edit</button
            >
          {/if}
          {#if canDelete(message)}
            {#if confirmingDeleteId === message.id}
              <button
                type="button"
                class="danger"
                onclick={() => {
                  void remove(message);
                  actionsFor = null;
                }}>Confirm</button
              >
              <button type="button" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
            {:else}
              <button type="button" title="Delete" onclick={() => (confirmingDeleteId = message.id)}>Delete</button>
            {/if}
          {/if}
        </div>
      </article>
    {/each}
  {/if}
</div>
