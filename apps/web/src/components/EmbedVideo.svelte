<script lang="ts">
  import type { EmbedPlayer } from '@harmony/shared';

  let {
    player,
    title,
    imageUrl,
  }: { player: EmbedPlayer; title: string | null; imageUrl: string | null } = $props();

  let playing = $state(false);

  /*
   * The embed origin is ours to choose, never the scraped page's, and the id is
   * the only thing the server sends. youtube-nocookie is YouTube's privacy
   * mode; nothing is loaded from it until the viewer presses play.
   */
  const embedUrl = $derived(`https://www.youtube-nocookie.com/embed/${player.id}?autoplay=1&rel=0`);
  const poster = $derived(imageUrl ? `/api/v1/embeds/media?url=${encodeURIComponent(imageUrl)}` : null);
</script>

{#if playing}
  <iframe
    class="embed-video-frame"
    src={embedUrl}
    title={title ?? 'Video player'}
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
    allowfullscreen
    referrerpolicy="strict-origin-when-cross-origin"
  ></iframe>
{:else}
  <button class="embed-video" type="button" aria-label={`Play ${title ?? 'video'}`} onclick={() => (playing = true)}>
    {#if poster}<img src={poster} alt="" loading="lazy" />{/if}
    <span class="embed-video-play" aria-hidden="true">▶</span>
  </button>
{/if}
