<script lang="ts">
  import { highlightCode } from '../lib/code-highlight';

  let { text, language }: { text: string; language: string | null } = $props();

  /** The highlighted markup once it arrives; until then the code shows plain. */
  let highlighted = $state<string | null>(null);
  let copied = $state(false);

  $effect(() => {
    highlighted = null;
    if (!language) return;
    // An edit or a recycled row can change the code while the highlighter is
    // still loading, and the stale answer must not land on the new code.
    let current = true;
    void highlightCode(text, language).then((html) => {
      if (current) highlighted = html;
    });
    return () => {
      current = false;
    };
  });

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard access can be refused; the code is still there to select.
    }
  }
</script>

<!--
  The highlighted markup comes from highlight.js, which escapes every character
  of the code itself and adds nothing but its own class-only spans; see
  lib/highlighter.ts for why that makes {@html} safe here. The two children are
  written back to back because the message text around them keeps whitespace,
  and a space between them would show as a blank line.
-->
<div class="code-block-frame"><pre class="code-block"><code class="hljs">{#if highlighted !== null}{@html highlighted}{:else}{text}{/if}</code></pre><button type="button" class="code-copy" title="Copy code" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
