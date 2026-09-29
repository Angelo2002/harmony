<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { channelGlyph } from '../lib/format';
  import { session } from '../lib/session.svelte';
  import ChannelSidebar from './ChannelSidebar.svelte';
  import Composer from './Composer.svelte';
  import MemberList from './MemberList.svelte';
  import MessageView from './MessageView.svelte';

  onMount(() => void chat.start());
  onDestroy(() => chat.stop());

  /** The "is typing…" line above the composer, or null when nobody is typing. */
  const typingLabel = $derived.by((): string | null => {
    if (!session.user?.showTyping) return null;
    const names = chat.typingUsers.map((entry) => entry.user.displayName ?? entry.user.username);
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return 'Several people are typing…';
  });
</script>

<div class="layout">
  <ChannelSidebar />

  {#if chat.activeChannel}
    <section class="chat">
      <header class="chat-header">{channelGlyph(chat.activeChannel)} {chat.activeChannel.name}</header>
      <MessageView />
      {#if typingLabel}
        <p class="typing">{typingLabel}</p>
      {/if}
      <Composer />
    </section>
  {:else}
    <section class="chat empty">
      <p class="muted">No channels yet.</p>
    </section>
  {/if}

  <MemberList />
</div>
