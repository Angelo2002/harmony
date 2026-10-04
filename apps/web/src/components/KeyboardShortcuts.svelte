<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { sidebarOrder, stepChannel } from '../lib/quick-switch';
  import { isTypingTarget, shortcuts } from '../lib/shortcuts.svelte';
  import QuickSwitcher from './QuickSwitcher.svelte';
  import ShortcutHelp from './ShortcutHelp.svelte';

  const ordered = $derived(sidebarOrder(chat.categories, chat.channels));
  const order = $derived(ordered.map((channel) => channel.id));
  /** Muted channels are skipped by the unread arrows, as on Discord, unless they hold a mention. */
  const unreadStops = $derived(
    new Set(
      ordered
        .filter((channel) => chat.unreadShown(channel) || chat.mentionsShown(channel) > 0)
        .map((channel) => channel.id),
    ),
  );

  // Every channel opened, by whatever route, is what the switcher offers first.
  $effect(() => {
    const id = chat.activeChannelId;
    if (id) untrack(() => shortcuts.noteVisit(id));
  });

  onMount(() => () => shortcuts.reset());

  async function step(direction: 1 | -1, unreadOnly: boolean): Promise<void> {
    const next = stepChannel(
      order,
      chat.activeChannelId,
      direction,
      unreadOnly ? (id) => unreadStops.has(id) : undefined,
    );
    if (!next) return;
    void chat.selectChannel(next);
    // A long sidebar scrolls, and a channel opened from the keyboard should not
    // end up highlighted somewhere out of sight.
    await tick();
    document.querySelector('.sidebar .channel.active')?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    // The admin, profile, search, inbox and setup panels all sit in this
    // overlay. Switching channels behind one would happen out of sight, so the
    // keyboard layer stays quiet while any of them is open.
    const panelOpen = document.querySelector('.admin-overlay') !== null;

    // The one shortcut that works from inside a text box, as it does in Discord:
    // it is how someone typing gets somewhere else without reaching for the mouse.
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      if (panelOpen) return;
      event.preventDefault();
      shortcuts.toggle('switcher');
      return;
    }

    if (shortcuts.panel !== null) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void shortcuts.close();
      } else if (mod && event.key === '/') {
        event.preventDefault();
        shortcuts.toggle('help');
      }
      return;
    }

    if (panelOpen || isTypingTarget(event.target)) return;

    if (mod && !event.altKey && event.key === '/') {
      event.preventDefault();
      shortcuts.open('help');
      return;
    }

    if (event.altKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      void step(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if shortcuts.panel === 'switcher'}
  <QuickSwitcher />
{:else if shortcuts.panel === 'help'}
  <ShortcutHelp />
{/if}
