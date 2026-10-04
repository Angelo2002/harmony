<script lang="ts">
  import type { Message } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { reminderChoices, saved } from '../lib/saved.svelte';

  /**
   * The Save / Remind entries in a message's action menu, open to anyone who can
   * see the message. A save is the member's own business, so the change goes
   * only to their other sessions; the saved flag on the message and the saved
   * panel follow from the store.
   */
  let {
    message,
    ondone,
    onerror,
  }: { message: Message; ondone: () => void; onerror: (text: string) => void } = $props();

  /** The reminder choices, worked out when the list opens so "in 30 minutes" means from now. */
  let choices = $state<ReturnType<typeof reminderChoices> | null>(null);
  let customAt = $state('');

  /** The earliest a custom reminder can be, in the form a datetime-local input takes. */
  function localNow(): string {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    choices = null;
    ondone();
    try {
      await action();
    } catch (cause) {
      onerror(cause instanceof ApiError ? cause.message : String(cause));
    }
  }

  function toggle(): void {
    void run(() => (message.saved ? saved.unsave(message) : saved.save(message)));
  }

  function remind(at: Date): void {
    void run(() => saved.save(message, at.toISOString()));
  }

  function remindCustom(event: SubmitEvent): void {
    event.preventDefault();
    // A datetime-local value has no zone, and the Date constructor reads it as
    // local time, which is the time the member picked.
    const at = new Date(customAt);
    if (Number.isNaN(at.getTime())) return;
    remind(at);
  }
</script>

<button
  type="button"
  title={message.saved ? 'Remove from saved' : 'Save message'}
  aria-label={message.saved ? 'Remove from saved' : 'Save message'}
  onclick={toggle}
>
  {message.saved ? 'Unsave' : 'Save'}
</button>
<span class="remind-action">
  <button
    type="button"
    title="Remind me"
    aria-expanded={choices !== null}
    onclick={() => {
      customAt = '';
      choices = choices ? null : reminderChoices();
    }}
  >
    Remind
  </button>
  {#if choices}
    <div class="remind-menu" role="group" aria-label="Remind me">
      {#each choices as choice (choice.label)}
        <button type="button" onclick={() => remind(choice.at)}>{choice.label}</button>
      {/each}
      <form class="remind-custom" onsubmit={remindCustom}>
        <input type="datetime-local" aria-label="Custom reminder time" min={localNow()} bind:value={customAt} required />
        <button type="submit" disabled={!customAt}>Set</button>
      </form>
    </div>
  {/if}
</span>
