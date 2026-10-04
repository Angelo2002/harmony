<script lang="ts">
  import { onMount } from 'svelte';
  import { fromDateTimeInputs, timestampChoices, toDateTimeInputs } from '../lib/time-input';
  import type { TimestampStyle } from '../lib/timestamp';

  /**
   * `onclose` says whether focus should go back to the message box: after
   * Escape it should, but a click elsewhere has already put focus where the
   * member wanted it.
   */
  let { onpick, onclose }: { onpick: (token: string) => void; onclose: (refocus: boolean) => void } = $props();

  // Native inputs keep this simple and give each platform its own date and
  // time widgets, in the member's own zone, which is the zone they think in.
  const opened = toDateTimeInputs(Date.now());
  let date = $state(opened.date);
  let time = $state(opened.time);
  let style = $state<TimestampStyle>('f');
  let dateInput = $state<HTMLInputElement | null>(null);

  const moment = $derived(fromDateTimeInputs(date, time));
  // "Now" is read again whenever the fields change, so the relative preview
  // stays honest without a ticking clock.
  const choices = $derived(
    moment === null ? [] : timestampChoices({ epochMs: moment, kind: 'datetime' }, { now: Date.now() }),
  );
  const chosen = $derived(choices.find((choice) => choice.style === style) ?? null);

  function insert(event: SubmitEvent): void {
    event.preventDefault();
    if (chosen) onpick(chosen.token);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // The composer would otherwise take the same Escape to cancel a reply.
    event.preventDefault();
    event.stopPropagation();
    onclose(true);
  }

  onMount(() => {
    dateInput?.focus();
    // A click anywhere else dismisses the popover, except on the button that
    // toggles it, which would otherwise close it only to open it again.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.timestamp-picker') || target?.closest('.timestamp-trigger')) return;
      onclose(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div class="timestamp-picker" role="dialog" aria-label="Insert a timestamp" tabindex="-1" onkeydown={onKeydown}>
  <form class="timestamp-form" onsubmit={insert}>
    <div class="timestamp-when">
      <label>
        Date
        <input type="date" bind:value={date} bind:this={dateInput} required />
      </label>
      <label>
        Time
        <input type="time" bind:value={time} required />
      </label>
    </div>

    <fieldset class="timestamp-styles">
      <legend>Style</legend>
      {#each choices as choice (choice.style)}
        <label class="timestamp-style" class:active={choice.style === style}>
          <input type="radio" name="timestamp-style" value={choice.style} bind:group={style} />
          <span class="timestamp-style-preview">{choice.preview}</span>
          <span class="timestamp-style-name">{choice.name}</span>
        </label>
      {:else}
        <p class="muted">Pick a date and a time.</p>
      {/each}
    </fieldset>

    <p class="muted timestamp-note">Everyone sees it in their own time zone.</p>
    <button type="submit" disabled={chosen === null}>Insert</button>
  </form>
</div>
