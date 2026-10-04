<script lang="ts">
  import { isApple, shortcuts, trapFocus } from '../lib/shortcuts.svelte';

  // Named the way the keys are printed on the keyboard in front of the reader.
  const mod = isApple ? '⌘' : 'Ctrl';
  const alt = isApple ? '⌥' : 'Alt';

  const groups: Array<{ title: string; rows: Array<{ keys: string[][]; label: string }> }> = [
    {
      title: 'Anywhere',
      rows: [
        { keys: [[mod, 'K']], label: 'Open the quick switcher' },
        { keys: [[mod, '/']], label: 'Show these shortcuts' },
        { keys: [[alt, '↑'], [alt, '↓']], label: 'Previous or next channel' },
        { keys: [[alt, 'Shift', '↑'], [alt, 'Shift', '↓']], label: 'Previous or next unread channel' },
      ],
    },
    {
      title: 'In the quick switcher',
      rows: [
        { keys: [['↑'], ['↓']], label: 'Move through the results' },
        { keys: [['Enter']], label: 'Open the highlighted result' },
        { keys: [['Esc']], label: 'Close' },
        { keys: [['#'], ['@']], label: 'Typed first, look only for channels or only for members' },
      ],
    },
  ];
</script>

<div class="sh-layer">
  <button
    class="sh-backdrop"
    type="button"
    tabindex="-1"
    aria-label="Close keyboard shortcuts"
    onclick={() => shortcuts.close()}
  ></button>

  <div class="sh-dialog" role="dialog" aria-modal="true" aria-labelledby="sh-title" use:trapFocus>
    <div class="sh-head">
      <h2 id="sh-title">Keyboard shortcuts</h2>
      <button type="button" data-autofocus onclick={() => shortcuts.close()}>Close</button>
    </div>

    <p class="sh-note">
      Apart from the quick switcher, these stay out of the way while you are typing in a box.
    </p>

    {#each groups as group (group.title)}
      <h3>{group.title}</h3>
      <dl>
        {#each group.rows as row (row.label)}
          <div class="sh-row">
            <dt>
              {#each row.keys as combo, index (index)}
                {#if index > 0}<span class="sh-or">/</span>{/if}
                {#each combo as key, keyIndex (keyIndex)}<kbd>{key}</kbd>{/each}
              {/each}
            </dt>
            <dd>{row.label}</dd>
          </div>
        {/each}
      </dl>
    {/each}
  </div>
</div>

<style>
  .sh-layer {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  .sh-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgb(0 0 0 / 70%);
    cursor: default;
  }

  .sh-dialog {
    position: relative;
    width: min(480px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    padding: 1.1rem 1.2rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-lg);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
  }

  .sh-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  h3 {
    margin: 1rem 0 0.4rem;
    color: var(--h-text-faint);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .sh-note {
    margin: 0.4rem 0 0;
    color: var(--h-text-muted);
    font-size: 0.85rem;
  }

  dl {
    margin: 0;
  }

  .sh-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--h-border);
  }

  dt {
    flex: none;
    order: 2;
  }

  dd {
    margin: 0;
    color: var(--h-text-muted);
    font-size: 0.9rem;
  }

  .sh-or {
    margin: 0 0.25rem;
    color: var(--h-text-faint);
  }

  kbd {
    display: inline-block;
    min-width: 1.5em;
    margin: 0 0.1em;
    padding: 0.05em 0.35em;
    border: 1px solid var(--h-border-strong);
    border-radius: var(--h-radius-xs);
    background: var(--h-bg-raised);
    color: var(--h-text);
    font-family: var(--h-font);
    font-size: 0.8rem;
    text-align: center;
  }
</style>
