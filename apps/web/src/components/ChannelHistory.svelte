<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import {
    mayCarryOn,
    mouseButtonStep,
    planVisit,
    popAction,
    readEntry,
    stepDirection,
    writeEntry,
  } from '../lib/channel-history';
  import { withoutLaunchParams } from '../lib/launch-params';
  import { lightbox } from '../lib/lightbox.svelte';
  import { shortcuts } from '../lib/shortcuts.svelte';
  import { ui } from '../lib/ui.svelte';

  /*
   * Back and forward between the channels opened in this tab. Each channel
   * opened, by whatever route, gets a browser history entry, so the browser's
   * own back and forward walk them; this component writes those entries and
   * follows the browser when it steps onto one. It draws nothing.
   */

  /** The position of the entry the page is on, to tell a step back from a step forward. */
  let index = readEntry(window.history.state)?.index ?? 0;

  function known(channelId: string): boolean {
    return chat.channels.some((channel) => channel.id === channelId);
  }

  // Watches only the open channel. Everything else is read untracked, so a
  // channel list refresh does not count as a visit.
  $effect(() => {
    const channelId = chat.activeChannelId;
    untrack(() => record(channelId));
  });

  function record(channelId: string | null): void {
    const current = readEntry(window.history.state);
    const plan = planVisit(current, channelId, current !== null && known(current.channelId), index);
    if (!plan) return;
    index = plan.entry.index;
    if (plan.op === 'push') {
      // The address stays as it is, less a launch link's parameters: they
      // belong to the entry the link arrived on, and an entry carrying them
      // would follow the link again on a reload instead of reopening its channel.
      const url = window.location.pathname + withoutLaunchParams(window.location.search) + window.location.hash;
      window.history.pushState(writeEntry(null, plan.entry), '', url);
    } else {
      window.history.replaceState(writeEntry(window.history.state, plan.entry), '');
    }
  }

  async function onPopState(event: PopStateEvent): Promise<void> {
    const entry = readEntry(event.state);
    if (!entry) return;
    const direction = stepDirection(index, entry.index);
    index = entry.index;
    // Until the channel list is in there is nothing to check the entry against.
    if (chat.channels.length === 0) return;

    const action = popAction(entry, chat.activeChannelId, known(entry.channelId));
    if (action === 'stale' && chat.activeChannelId) {
      window.history.replaceState(
        writeEntry(event.state, { channelId: chat.activeChannelId, index: entry.index }),
        '',
      );
    }
    if (action !== 'open') {
      // Going past the last entry this way does nothing, which is the right
      // answer when every entry left that way is gone or already open.
      if (mayCarryOn(direction, entry.index)) window.history.go(direction);
      return;
    }

    // Every panel and drawer closes when a channel is jumped to from one, and
    // some of them (pins, the gallery) belong to the channel they were opened
    // from, so a step that changes the channel closes them the same way.
    ui.closeAll();
    lightbox.close();
    void shortcuts.close();
    void chat.selectChannel(entry.channelId);
    // As for the channel arrows: a long sidebar scrolls, and the channel just
    // opened should not be highlighted somewhere out of sight.
    await tick();
    document.querySelector('.sidebar .channel.active')?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * The mouse's side buttons. Chrome and the browsers built on it navigate as
   * the default action of this mouseup, and Firefox never shows these buttons to
   * the page at all and navigates by itself; either way the entries above are
   * what it walks. Some engines (Safari, some desktop app shells) hand the page
   * the event and do nothing more, so the step is taken here. The default is
   * prevented first, so a browser that would have navigated as well does not
   * take the step twice.
   */
  function onMouseUp(event: MouseEvent): void {
    const step = mouseButtonStep(event.button);
    if (step === null) return;
    event.preventDefault();
    window.history.go(step);
  }
</script>

<svelte:window onpopstate={onPopState} onmouseup={onMouseUp} />
