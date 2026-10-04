<script lang="ts">
  import type { MessageBlock } from '../lib/message-text';
  import MessageContent from './MessageContent.svelte';

  /** The draft as it will read once sent, so a `:name:` shows as its emoji. */
  let { blocks }: { blocks: MessageBlock[] } = $props();
</script>

<!--
  Decoration only: the textarea stays the accessible source, so a screen reader
  does not hear the draft twice. Nothing in the strip takes focus or a click.
-->
<div class="composer-preview" aria-hidden="true">
  <MessageContent {blocks} />
</div>
