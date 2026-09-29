<script lang="ts">
  import { chat } from '../lib/chat.svelte';

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
      <article class="message">
        <div class="avatar">{(message.author?.username ?? '?').charAt(0).toUpperCase()}</div>
        <div class="body">
          <div class="meta">
            <span class="author">{message.author?.displayName ?? message.author?.username ?? 'Unknown'}</span>
            <time>{formatTime(message.createdAt)}</time>
            {#if message.editedAt}<span class="edited">(edited)</span>{/if}
          </div>
          <p class="content">{message.content}</p>
        </div>
      </article>
    {/each}
  {/if}
</div>
