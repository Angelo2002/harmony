<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { dragHasFiles, imageFilesFrom } from '../lib/files';
  import { channelGlyph } from '../lib/format';
  import { session } from '../lib/session.svelte';
  import { uploads } from '../lib/upload-queue.svelte';
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

  /**
   * Dragging a file over the chat offers a drop zone. Enter and leave fire for
   * every element the pointer crosses, so they are counted rather than toggled.
   */
  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);

  function onDragEnter(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
  }

  function onDragOver(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    // Without this the browser refuses the drop entirely.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function onDrop(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    // The composer owns uploading; it picks these up from the queue.
    uploads.drop(imageFilesFrom(event.dataTransfer));
  }
</script>

<div class="layout">
  <ChannelSidebar />

  {#if chat.activeChannel}
    <section
      class="chat"
      aria-label={`#${chat.activeChannel.name}`}
      ondragenter={onDragEnter}
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
    >
      <header class="chat-header">{channelGlyph(chat.activeChannel)} {chat.activeChannel.name}</header>
      <MessageView />
      {#if typingLabel}
        <p class="typing">{typingLabel}</p>
      {/if}
      <Composer />

      {#if dragging}
        <div class="drop-zone"><span>Drop images to attach them</span></div>
      {/if}
    </section>
  {:else}
    <section class="chat empty">
      <p class="muted">No channels yet.</p>
    </section>
  {/if}

  <MemberList />
</div>
