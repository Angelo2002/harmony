<script lang="ts">
  import { onMount } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { dragHasFiles, mediaFilesFrom } from '../lib/files';
  import { channelGlyph } from '../lib/format';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import { uploads } from '../lib/upload-queue.svelte';
  import ChannelSidebar from './ChannelSidebar.svelte';
  import Composer from './Composer.svelte';
  import MemberList from './MemberList.svelte';
  import MessageView from './MessageView.svelte';

  onMount(() => {
    void chat.start();

    // A phone that backgrounds the app gets no events at all: the socket dies and
    // nothing scrolls past. Coming back to the foreground is the cue to reconnect
    // and catch up, which is what makes a reopened installed app show the newest
    // messages instead of whatever was on screen when it went away.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void chat.resync();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      chat.stop();
    };
  });

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
    uploads.drop(mediaFilesFrom(event.dataTransfer));
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
      <header class="chat-header">
        <button
          class="drawer-toggle"
          type="button"
          aria-label="Show channels"
          aria-expanded={ui.sidebarOpen}
          onclick={() => ui.toggleSidebar()}
        >
          ☰
        </button>
        <span class="chat-title">{channelGlyph(chat.activeChannel)} {chat.activeChannel.name}</span>
        <button
          type="button"
          class="inbox-open"
          class:has-mentions={chat.mentionChannelIds.length > 0}
          aria-label="Mentions and replies"
          title="Mentions and replies"
          onclick={() => ui.openInbox()}
        >
          📥
        </button>
        <button
          type="button"
          class="search-open"
          aria-label="Search messages"
          title="Search messages"
          onclick={() => ui.openSearch()}
        >
          🔍
        </button>
        <button
          class="drawer-toggle"
          type="button"
          aria-label="Show members"
          aria-expanded={ui.rosterOpen}
          onclick={() => ui.toggleRoster()}
        >
          👥
        </button>
      </header>
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
      <button
        class="drawer-toggle"
        type="button"
        aria-label="Show channels"
        aria-expanded={ui.sidebarOpen}
        onclick={() => ui.toggleSidebar()}
      >
        ☰
      </button>
      <p class="muted">No channels yet.</p>
    </section>
  {/if}

  <MemberList />

  {#if ui.sidebarOpen || ui.rosterOpen}
    <button class="drawer-backdrop" type="button" aria-label="Close menu" onclick={() => ui.closeDrawers()}></button>
  {/if}
</div>
