<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import ChannelSidebar from './ChannelSidebar.svelte';
  import Composer from './Composer.svelte';
  import MessageView from './MessageView.svelte';

  onMount(() => void chat.start());
  onDestroy(() => chat.stop());
</script>

<div class="layout">
  <ChannelSidebar />

  {#if chat.activeChannel}
    <section class="chat">
      <header class="chat-header"># {chat.activeChannel.name}</header>
      <MessageView />
      <Composer />
    </section>
  {:else}
    <section class="chat empty">
      <p class="muted">No channels yet.</p>
    </section>
  {/if}
</div>
