<script lang="ts">
  import { HARMONY_NAME, HARMONY_REPO_URL, HARMONY_VERSION } from '@harmony/shared';
  import { meta } from '../lib/meta.svelte';
  import { ui } from '../lib/ui.svelte';

  /** The address without its scheme, which reads better as a link label. */
  const repoLabel = HARMONY_REPO_URL.replace(/^https?:\/\//, '');
</script>

<div class="admin-overlay">
  <button class="overlay-close" type="button" aria-label="Close" onclick={() => ui.closeAbout()}></button>

  <div class="admin about">
    <div class="admin-body">
      <div class="about-head">
        <img class="server-icon large" src={meta.iconUrl} alt="" />
        <h3>{meta.serverName}</h3>
      </div>

      <p class="about-powered">Powered by {HARMONY_NAME}</p>

      <a class="about-link" href={HARMONY_REPO_URL} target="_blank" rel="noopener noreferrer">
        {repoLabel}
      </a>

      <p class="about-version muted">Version {HARMONY_VERSION}</p>

      <div class="editor-actions">
        <button type="button" onclick={() => ui.closeAbout()}>Close</button>
      </div>
    </div>
  </div>
</div>
