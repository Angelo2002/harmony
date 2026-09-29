<script lang="ts">
  import { onMount } from 'svelte';
  import type { ServerSettingsResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let serverName = $state('');
  let requireInvite = $state(false);
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const settings = await api<ServerSettingsResponse>('/settings');
      serverName = settings.serverName;
      requireInvite = settings.requireInvite;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      const updated = await api<ServerSettingsResponse>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ serverName: serverName.trim(), requireInvite }),
      });
      serverName = updated.serverName;
      requireInvite = updated.requireInvite;
      message = 'Settings saved.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Server settings</h3>
  <form onsubmit={save}>
    <label>
      Server name
      <input bind:value={serverName} required maxlength="64" />
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={requireInvite} />
      Require an invite code to register
    </label>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
</section>
