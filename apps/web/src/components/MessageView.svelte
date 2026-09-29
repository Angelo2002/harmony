<script lang="ts">
  import type { Message } from '@harmony/shared';
  import { chat } from '../lib/chat.svelte';
  import { avatarUrl, initial } from '../lib/avatar';
  import { tokenizeEmoji } from '../lib/emoji-text';
  import { emojis } from '../lib/emojis.svelte';

  let scroller = $state<HTMLDivElement | null>(null);

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

  // Keep the newest message in view as messages arrive.
  $effect(() => {
    if (chat.messages.length > 0) scroller?.scrollTo({ top: scroller.scrollHeight });
  });
</script>

<div class="messages" bind:this={scroller}>
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
      {@const segments = tokenizeEmoji(message.content, emojis.lookup)}
      {@const picture = avatarUrl(message.author)}
      <article class="message">
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
        </div>

        <div class="message-actions">
          <button type="button" title="Reply" onclick={() => (chat.replyTarget = message)}>Reply</button>
        </div>
      </article>
    {/each}
  {/if}
</div>
