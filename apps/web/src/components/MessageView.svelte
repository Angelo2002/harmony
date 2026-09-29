<script lang="ts">
  import { Permission, hasPermission, type Message } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { avatarUrl, initial } from '../lib/avatar';
  import { tokenizeMessage } from '../lib/message-text';
  import { emojis } from '../lib/emojis.svelte';
  import { members } from '../lib/members.svelte';
  import { session } from '../lib/session.svelte';
  import EmojiPicker from './EmojiPicker.svelte';

  let scroller = $state<HTMLDivElement | null>(null);
  /** The message whose reaction picker is open, if any. */
  let pickerFor = $state<string | null>(null);
  /** The message currently being edited, and its draft text. */
  let editingId = $state<string | null>(null);
  let editValue = $state('');
  /** The message whose delete is awaiting confirmation. */
  let confirmingDeleteId = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  const myId = $derived(session.user?.id);
  const permissions = $derived(BigInt(session.permissions || '0'));

  // Custom emoji that can actually be rendered; deleted ones fall back to text.
  const knownEmojiIds = $derived(new Set(emojis.list.map((emoji) => emoji.id)));

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

  // Keep the newest message in view as messages arrive.
  $effect(() => {
    if (chat.messages.length > 0) scroller?.scrollTo({ top: scroller.scrollHeight });
  });
</script>

<div class="messages" bind:this={scroller}>
  {#if actionError}
    <p class="form-error pad">{actionError}</p>
  {/if}

  {#if chat.loading}
    <p class="muted pad">Loading…</p>
  {:else if chat.messages.length === 0}
    <p class="muted pad">No messages yet. Say hello!</p>
  {:else}
    {#each chat.messages as message (message.id)}
      {@const authorColor =
        message.author?.roleColor == null
          ? null
          : `#${message.author.roleColor.toString(16).padStart(6, '0')}`}
      {@const segments = tokenizeMessage(message.content, emojis.lookup, (name) =>
        members.byUsername.get(name.toLowerCase()),
      )}
      {@const mentionsMe = segments.some((segment) => segment.type === 'mention' && segment.user.id === myId)}
      {@const picture = avatarUrl(message.author)}
      <article class="message" class:mentions-me={mentionsMe}>
        {#if picture}
          <img class="avatar" src={picture} alt="" loading="lazy" />
        {:else}
          <div class="avatar fallback">{initial(message.author)}</div>
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

          <div class="meta">
            <span class="author" style={authorColor ? `color: ${authorColor}` : ''}>
              {authorName(message)}
            </span>
            <time>{formatTime(message.createdAt)}</time>
            {#if message.editedAt}<span class="edited">(edited)</span>{/if}
          </div>

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
              <p class="content">
                {#each segments as segment, i (i)}
                  {#if segment.type === 'emoji'}
                    <img
                      class="emoji"
                      src={`/api/v1/emojis/${segment.emoji.id}`}
                      alt={`:${segment.emoji.name}:`}
                      title={`:${segment.emoji.name}:`}
                    />
                  {:else if segment.type === 'mention'}
                    <span class="mention" title={`@${segment.user.username}`}>
                      @{segment.user.displayName ?? segment.user.username}
                    </span>
                  {:else}
                    {segment.value}
                  {/if}
                {/each}
              </p>
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
          {/if}

          {#if pickerFor === message.id}
            <EmojiPicker onpick={(emoji, emojiId) => pickReaction(message, emoji, emojiId)} />
          {/if}
        </div>

        <div class="message-actions">
          <button type="button" title="Reply" onclick={() => (chat.replyTarget = message)}>Reply</button>
          <button
            type="button"
            title="Add reaction"
            onclick={() => (pickerFor = pickerFor === message.id ? null : message.id)}
          >
            React
          </button>
          {#if canEdit(message)}
            <button type="button" title="Edit" onclick={() => startEdit(message)}>Edit</button>
          {/if}
          {#if canDelete(message)}
            {#if confirmingDeleteId === message.id}
              <button type="button" class="danger" onclick={() => remove(message)}>Confirm</button>
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
