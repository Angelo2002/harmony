<script lang="ts">
  import { onMount } from 'svelte';
  import type { VoiceState } from '@harmony/shared';
  import { session } from '../lib/session.svelte';
  import { voice } from '../lib/voice.svelte';
  import { VOICE_VOLUME_MAX } from '../lib/voice-volume';

  /**
   * The menu one member of a voice channel opens on right-click or long-press:
   * that member's playback volume, applied locally.
   *
   * The volume is a gain on this client's incoming audio, so it never leaves the
   * browser and never touches the server's record or anyone else's audio. The
   * slider runs 0-200% with 100% as the default; dragging it changes the member's
   * level as it moves. A row for yourself has no playback gain to set, so it
   * offers your own mute toggle instead.
   */
  let {
    entry,
    x,
    y,
    onclose,
  }: { entry: VoiceState; x: number; y: number; onclose: () => void } = $props();

  let menu = $state<HTMLDivElement | null>(null);
  /** Where the menu actually sits once it has been kept inside the window. */
  let left = $state(0);
  let top = $state(0);

  const userId = $derived(entry.user.id);
  const name = $derived(entry.user.displayName ?? entry.user.username);
  const isSelf = $derived(session.user?.id === userId);
  const gain = $derived(voice.volumeFor(userId));
  const percent = $derived(Math.round(gain * 100));
  const muted = $derived(gain === 0);
  const adjusted = $derived(voice.volumeAdjusted(userId));
  const maxPercent = VOICE_VOLUME_MAX * 100;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onclose();
  }

  onMount(() => {
    // Keep the whole menu on screen however near an edge the click was.
    const width = menu?.offsetWidth ?? 220;
    const height = menu?.offsetHeight ?? 180;
    left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - height - 8));

    /*
     * Move focus into the menu, so Escape closes it and the controls are
     * reachable without a pointer. This focuses the first control and leaves
     * the rest to Tab: a range input needs the arrow keys for its own value,
     * so a roving arrow-key focus (as the channel menu uses) would fight it.
     */
    menu?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // A Node for real pointer input, but not necessarily for a synthetic or
      // non-element event; Node.contains throws on anything that is not a Node,
      // and the throw would skip onclose(). Treat anything that is not a Node
      // inside the menu as an outside press and close.
      if (!(target instanceof Node) || !menu?.contains(target)) onclose();
    };
    // Captured, so a press on anything else closes the menu before it acts. A
    // resize is deliberately left alone: a phone fires one whenever its toolbar
    // slides away, which would shut the menu under the member's thumb.
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div
  class="member-menu"
  role="menu"
  tabindex="-1"
  aria-label={name}
  bind:this={menu}
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={onKeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  <p class="member-name" role="none">
    <span class="member-name-text">{name}</span>
    {#if isSelf}<span class="member-you">you</span>{/if}
  </p>

  {#if isSelf}
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={voice.muted}
      onclick={() => voice.setMuted(!voice.muted)}
    >
      {voice.muted ? 'Unmute yourself' : 'Mute yourself'}
    </button>
  {:else}
    <div class="volume" role="group" aria-label={`Volume for ${name}`}>
      <div class="volume-head">
        <span class="volume-label">Volume</span>
        <span class="volume-value">{percent}%</span>
      </div>
      <input
        class="volume-slider"
        type="range"
        min="0"
        max={maxPercent}
        step="5"
        value={percent}
        aria-label={`${name} volume`}
        oninput={(event) => voice.setVolume(userId, Number((event.currentTarget as HTMLInputElement).value) / 100)}
      />
    </div>

    <button type="button" role="menuitemcheckbox" aria-checked={muted} onclick={() => voice.toggleMuted(userId)}>
      Mute
    </button>

    <button type="button" role="menuitem" disabled={!adjusted} onclick={() => voice.resetVolume(userId)}>
      Reset to 100%
    </button>
  {/if}
</div>

<style>
  .member-menu {
    position: fixed;
    z-index: 200;
    width: 220px;
    padding: 0.35rem;
    border-radius: var(--h-radius);
    background: var(--h-bg-elevated);
    border: 1px solid var(--h-border);
    box-shadow: var(--h-shadow-lg);
    font-size: 0.85rem;
  }

  .member-menu:focus {
    outline: none;
  }

  .member-name {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.35rem 0.6rem 0.25rem;
    color: var(--h-text-muted);
    font-size: 0.78rem;
    font-weight: 600;
  }

  .member-name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-you {
    flex: none;
    opacity: 0.7;
    font-weight: 500;
  }

  button {
    display: flex;
    position: relative;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border-radius: var(--h-radius-xs);
    background: none;
    color: var(--h-text-muted);
    font-size: 0.85rem;
    font-weight: 500;
    text-align: left;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--h-accent);
    color: var(--h-on-accent);
    box-shadow: none;
    outline: none;
  }

  button:active:not(:disabled) {
    transform: none;
  }

  .volume {
    padding: 0.15rem 0.6rem 0.35rem;
  }

  .volume-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
    color: var(--h-text-muted);
    font-size: 0.78rem;
  }

  .volume-value {
    font-variant-numeric: tabular-nums;
  }

  .volume-slider {
    width: 100%;
    height: 1rem;
    margin: 0;
    accent-color: var(--h-accent);
    cursor: pointer;
  }
</style>
