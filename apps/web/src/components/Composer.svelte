<script lang="ts">
  import { chat } from '../lib/chat.svelte';

  let value = $state('');
  let busy = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const content = value.trim();
    if (!content || busy) return;

    busy = true;
    try {
      await chat.sendMessage(content);
      value = '';
    } finally {
      busy = false;
    }
  }
</script>

<form class="composer" onsubmit={submit}>
  <input
    bind:value
    placeholder={`Message #${chat.activeChannel?.name ?? ''}`}
    autocomplete="off"
    aria-label="Message"
  />
</form>
