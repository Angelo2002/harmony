<script lang="ts">
  import { lightbox } from '../lib/lightbox.svelte';
  import Icon from './Icon.svelte';

  // Escape closes it, as it does every other panel. The event is stopped so a
  // key that reached the app underneath (the composer, a search box) does not
  // also act on it.
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && lightbox.url) {
      event.stopPropagation();
      lightbox.close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if lightbox.url}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={lightbox.alt || 'Image'}>
    <button
      type="button"
      class="lightbox-backdrop"
      aria-label="Close image"
      onclick={() => lightbox.close()}
    ></button>
    <img class="lightbox-image" src={lightbox.url} alt={lightbox.alt} />
    <button type="button" class="lightbox-close" aria-label="Close" onclick={() => lightbox.close()}>
      <Icon name="close" size={22} />
    </button>
  </div>
{/if}
