<script lang="ts">
  import { onMount } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { meta } from '../lib/meta.svelte';
  import { unreadBadge, unreadTitle } from '../lib/quick-switch';

  /**
   * The Badging API, which only some browsers have and only an installed app
   * shows. It is described here rather than trusted to the DOM typings, which
   * may or may not know about it depending on the TypeScript in use.
   */
  interface BadgingNavigator {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  }

  /*
   * Counted over the channels actually listed, so a stale id the server still
   * remembers for a channel this member can no longer see cannot keep the tab
   * marked with nothing in the sidebar to explain it.
   */
  const mentions = $derived(chat.channels.filter((channel) => chat.mention.has(channel.id)).length);
  const unread = $derived(
    chat.channels.filter((channel) => chat.unread.has(channel.id) || chat.mention.has(channel.id)).length,
  );

  $effect(() => {
    document.title = unreadTitle(meta.serverName, mentions, unread);
  });

  $effect(() => {
    setBadge(unreadBadge(mentions, unread));
  });

  /** Best effort: a browser may refuse, such as when the app is not installed. */
  function setBadge(value: number | 'dot' | null): void {
    const badging = navigator as BadgingNavigator;
    try {
      if (value === null) {
        void badging.clearAppBadge?.().catch(() => {});
      } else {
        // No argument draws the plain dot, which is how a badge says "something
        // new" without a number, matching the dot in the title.
        void (value === 'dot' ? badging.setAppBadge?.() : badging.setAppBadge?.(value))?.catch(() => {});
      }
    } catch {
      // Some browsers throw outright instead of rejecting; there is nothing to do.
    }
  }

  // Signing out tears the chat down, and the tab should stop claiming unread
  // messages nobody can see any more.
  onMount(() => () => {
    document.title = meta.serverName;
    setBadge(null);
  });
</script>
