<script lang="ts">
  import { emojis } from '../lib/emojis.svelte';

  let { onpick }: { onpick: (emoji: string, emojiId: string | null) => void } = $props();

  /** A few common unicode emoji, so reacting does not require typing. */
  const quickReactions = ['👍', '❤️', '😂', '🎉', '😮', '😢'];
</script>

<div class="emoji-picker reaction-picker">
  {#each quickReactions as quick (quick)}
    <button type="button" class="emoji-option" onclick={() => onpick(quick, null)}>{quick}</button>
  {/each}

  {#each emojis.list as emoji (emoji.id)}
    <button
      type="button"
      class="emoji-option"
      title={`:${emoji.name}:`}
      onclick={() => onpick(`:${emoji.name}:`, emoji.id)}
    >
      <img src={`/api/v1/emojis/${emoji.id}`} alt={emoji.name} />
    </button>
  {/each}
</div>
