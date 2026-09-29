<script lang="ts">
  import { onMount } from 'svelte';
  import type { Emoji, EmojiListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { emojis } from '../../lib/emojis.svelte';

  let list = $state<Emoji[]>([]);
  let name = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function load(): Promise<void> {
    list = (await api<EmojiListResponse>('/emojis')).emojis;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  async function upload(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = fileInput?.files?.[0];
    if (!file || !name.trim()) return;

    busy = true;
    error = null;
    try {
      const form = new FormData();
      form.append('name', name.trim());
      form.append('file', file);
      await api<Emoji>('/emojis', { method: 'POST', body: form });
      name = '';
      if (fileInput) fileInput.value = '';
      await load();
      await emojis.load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function remove(id: string): Promise<void> {
    busy = true;
    error = null;
    try {
      await api(`/emojis/${id}`, { method: 'DELETE' });
      await load();
      await emojis.load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Custom emoji</h3>

  <form class="inline" onsubmit={upload}>
    <input bind:value={name} placeholder="Emoji name" required maxlength="32" />
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" bind:this={fileInput} />
    <button type="submit" disabled={busy}>Upload emoji</button>
  </form>

  {#if error}<p class="form-error">{error}</p>{/if}

  {#if list.length === 0}
    <p class="muted">No custom emoji yet. Upload one, then type :name: in a message.</p>
  {:else}
    <div class="emoji-grid">
      {#each list as emoji (emoji.id)}
        <div class="emoji-card">
          <img src={`/api/v1/emojis/${emoji.id}`} alt={emoji.name} />
          <span>:{emoji.name}:</span>
          <button type="button" class="danger" onclick={() => remove(emoji.id)} disabled={busy}>Delete</button>
        </div>
      {/each}
    </div>
  {/if}
</section>
