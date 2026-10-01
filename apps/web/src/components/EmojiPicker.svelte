<script lang="ts">
  import { emojis } from '../lib/emojis.svelte';
  import { filterByName, filterUnicodeGroups, loadUnicodeEmoji, type UnicodeEmojiGroup } from '../lib/unicode-emoji';

  let { onpick }: { onpick: (emoji: string, emojiId: string | null) => void } = $props();

  /** The most common reactions, within reach of both tabs rather than a scroll away. */
  const quickReactions = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

  type Tab = 'server' | 'unicode';
  /** The instance's own emoji first: they are the ones people came here for. */
  let tab = $state<Tab>('server');
  let query = $state('');

  let unicodeGroups = $state<UnicodeEmojiGroup[]>([]);
  let unicodeFailed = $state(false);

  // Started as soon as the picker opens, so the tab is usually already filled by
  // the time anyone reaches for it. The module keeps the result, so this is a
  // background load once per session rather than once per picker.
  void loadUnicodeEmoji()
    .then((groups) => {
      unicodeGroups = groups;
    })
    .catch(() => {
      unicodeFailed = true;
    });

  const serverMatches = $derived(filterByName(emojis.list, query));
  const unicodeMatches = $derived(filterUnicodeGroups(unicodeGroups, query));

  /** Searching is a different task from browsing, so the shortcuts step aside. */
  const searching = $derived(query.trim().length > 0);
</script>

<div class="emoji-picker">
  <div class="emoji-picker-head">
    <input
      class="emoji-search"
      type="search"
      bind:value={query}
      placeholder="Search emoji"
      aria-label="Search emoji"
      autocomplete="off"
    />
    <div class="emoji-tabs">
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'server'}
        aria-pressed={tab === 'server'}
        onclick={() => (tab = 'server')}
      >
        Server
      </button>
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'unicode'}
        aria-pressed={tab === 'unicode'}
        onclick={() => (tab = 'unicode')}
      >
        Unicode
      </button>
    </div>
  </div>

  <div class="emoji-picker-body">
    {#if !searching}
      <div class="emoji-quick">
        {#each quickReactions as quick (quick)}
          <button type="button" class="emoji-option" onclick={() => onpick(quick, null)}>{quick}</button>
        {/each}
      </div>
    {/if}

    {#if tab === 'server'}
      {#if serverMatches.length === 0}
        <p class="muted emoji-empty">
          {searching ? 'No server emoji match that.' : 'This server has no custom emoji yet.'}
        </p>
      {:else}
        <div class="emoji-options">
          {#each serverMatches as emoji (emoji.id)}
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
      {/if}
    {:else if unicodeFailed}
      <p class="muted emoji-empty">Could not load the unicode emoji list. Check your connection.</p>
    {:else if unicodeGroups.length === 0}
      <p class="muted emoji-empty">Loading…</p>
    {:else if unicodeMatches.length === 0}
      <p class="muted emoji-empty">No emoji match that.</p>
    {:else}
      {#each unicodeMatches as group (group.name)}
        <div>
          <!--
            The heading is dropped while searching: a handful of results split
            across nine headings reads worse than one plain list.
          -->
          {#if !searching}<span class="emoji-group-name">{group.name}</span>{/if}
          <div class="emoji-options">
            {#each group.emojis as emoji (emoji.emoji)}
              <button type="button" class="emoji-option" title={emoji.name} onclick={() => onpick(emoji.emoji, null)}>
                {emoji.emoji}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
