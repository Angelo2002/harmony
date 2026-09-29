<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    DiscordEmojiListResponse,
    Emoji,
    EmojiImportResponse,
    EmojiListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { emojis } from '../../lib/emojis.svelte';

  let list = $state<Emoji[]>([]);
  let name = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let discord = $state<DiscordEmojiListResponse | null>(null);
  let importMessage = $state<string | null>(null);
  let importOk = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  /** How many of the Discord emoji are not here yet. */
  const newCount = $derived(discord?.emojis.filter((emoji) => !emoji.imported).length ?? 0);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  async function load(): Promise<void> {
    list = (await api<EmojiListResponse>('/emojis')).emojis;
  }

  onMount(() => {
    void load().catch(fail);
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
      fail(cause);
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
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Looks up the linked guild's emoji before importing, so the admin sees the count. */
  async function checkDiscord(): Promise<void> {
    busy = true;
    error = null;
    importMessage = null;
    try {
      discord = await api<DiscordEmojiListResponse>('/emojis/discord');
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  function describeImport(result: EmojiImportResponse): { text: string; ok: boolean } {
    if (result.imported === 0 && result.failed === 0) {
      return {
        text: result.skipped > 0 ? 'Every Discord emoji is already here.' : 'That server has no custom emoji.',
        ok: true,
      };
    }
    const parts = [`imported ${result.imported}`];
    if (result.skipped > 0) parts.push(`${result.skipped} already here`);
    if (result.failed > 0) parts.push(`${result.failed} could not be read`);
    return { text: `Import finished: ${parts.join(', ')}.`, ok: result.failed === 0 };
  }

  async function importEmoji(): Promise<void> {
    busy = true;
    error = null;
    try {
      const result = await api<EmojiImportResponse>('/emojis/import', { method: 'POST' });
      const described = describeImport(result);
      importOk = described.ok;
      importMessage = described.text;
      discord = null;
      await load();
      await emojis.load();
    } catch (cause) {
      fail(cause);
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

  <div class="panel">
    <h2>Import from Discord</h2>
    <p class="muted">
      Copy the linked Discord server's custom emoji over in one go. Names that already exist are
      left alone, so it is safe to run more than once. Needs the bridge to be connected.
    </p>

    <div class="editor-actions">
      <button type="button" onclick={checkDiscord} disabled={busy}>Check Discord emoji</button>
      {#if newCount > 0}
        <button type="button" onclick={importEmoji} disabled={busy}>Import {newCount} emoji</button>
        <button type="button" onclick={() => (discord = null)} disabled={busy}>Cancel</button>
      {/if}
    </div>

    {#if discord}
      {#if discord.guildName === null}
        <p class="muted">The Discord bridge is not connected. Set a bot token in the Bridge panel first.</p>
      {:else if discord.emojis.length === 0}
        <p class="muted">No custom emoji found in <strong>{discord.guildName}</strong>.</p>
      {:else}
        <p class="muted">
          {discord.emojis.length} emoji in <strong>{discord.guildName}</strong>{#if newCount > 0},
            {newCount} new{:else}, all already here{/if}.
        </p>
        <ul class="chips">
          {#each discord.emojis as emoji (emoji.id)}
            <li class:imported={emoji.imported}>{emoji.name}{#if emoji.imported} ✓{/if}</li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if importMessage}
      <p class={importOk ? 'ok-text' : 'form-error'}>{importMessage}</p>
    {/if}
  </div>
</section>
