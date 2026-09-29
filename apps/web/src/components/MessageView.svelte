<script lang="ts">
  import { chat } from '../lib/chat.svelte';
  import { tokenizeEmoji } from '../lib/emoji-text';
  import { emojis } from '../lib/emojis.svelte';

  let scroller = $state<HTMLDivElement | null>(null);

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      <article class="message">
        <div class="avatar">{(message.author?.username ?? '?').charAt(0).toUpperCase()}</div>
        <div class="body">
          <div class="meta">
            <span class="author" style={authorColor ? `color: ${authorColor}` : ''}>
              {message.author?.displayName ?? message.author?.username ?? 'Unknown'}
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
      </article>
    {/each}
  {/if}
</div>
