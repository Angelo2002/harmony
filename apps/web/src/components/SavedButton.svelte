<script lang="ts">
  import type { Message } from '@harmony/shared';
  import { saved } from '../lib/saved.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  /**
   * The header button that opens the saved panel. It carries the dot for a
   * reminder that is due, and the notice that pops up when one comes due while
   * the app is open, so everything a reminder shows lives beside the panel it
   * points to.
   */

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /** A line of the message for the notice; the panel is where it is read in full. */
  function snippet(message: Message): string {
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text.length === 0) return message.attachments.length > 0 ? '(attachment)' : '';
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }

  function openPanel(): void {
    saved.notice = null;
    ui.openSaved();
  }
</script>

<button
  type="button"
  class="saved-open"
  class:has-due={saved.due.length > 0}
  aria-label={saved.due.length > 0
    ? `Saved messages, ${saved.due.length} reminder${saved.due.length === 1 ? '' : 's'} due`
    : 'Saved messages'}
  title="Saved messages"
  onclick={openPanel}
>
  <Icon name="bookmark" size={20} />
</button>

{#if saved.notice}
  <div class="reminder-notice" role="status">
    <p>
      <strong>Reminder</strong>
      <span class="muted">{authorName(saved.notice.message)}:</span>
      {snippet(saved.notice.message)}
    </p>
    <div class="reminder-notice-actions">
      <button type="button" onclick={openPanel}>View</button>
      <button type="button" class="ghost" onclick={() => (saved.notice = null)}>Dismiss</button>
    </div>
  </div>
{/if}
