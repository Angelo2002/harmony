<script lang="ts">
  import { ALLOWED_IMAGE_TYPES, LIMITS, type MeResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');

  let displayName = $state(session.user?.displayName ?? '');
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  const picture = $derived(avatarUrl(session.user));

  function apply(data: MeResponse): void {
    session.user = data.user;
    session.permissions = data.permissions;
    displayName = data.user.displayName ?? '';
  }

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  async function saveName(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      apply(
        await api<MeResponse>('/users/@me', {
          method: 'PATCH',
          body: JSON.stringify({ displayName: displayName.trim() || null }),
        }),
      );
      message = 'Profile saved.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function uploadAvatar(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    busy = true;
    error = null;
    message = null;
    try {
      const form = new FormData();
      form.append('file', file);
      apply(await api<MeResponse>('/users/@me/avatar', { method: 'PUT', body: form }));
      message = 'Profile picture updated.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function removeAvatar(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      apply(await api<MeResponse>('/users/@me/avatar', { method: 'DELETE' }));
      message = 'Profile picture removed.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="admin-overlay">
  <div class="admin profile-panel">
    <div class="admin-body">
      <h3>Your profile</h3>

      <div class="profile-avatar">
        {#if picture}
          <img class="avatar large" src={picture} alt="" />
        {:else}
          <span class="avatar large fallback">{initial(session.user)}</span>
        {/if}

        <div class="editor-actions">
          <button type="button" onclick={() => fileInput?.click()} disabled={busy}>Change picture</button>
          {#if picture}
            <button type="button" class="danger" onclick={removeAvatar} disabled={busy}>Remove</button>
          {/if}
          <input
            class="file-input"
            type="file"
            accept={acceptAttribute}
            bind:this={fileInput}
            onchange={uploadAvatar}
          />
        </div>
      </div>

      <form onsubmit={saveName}>
        <label>
          Display name
          <input bind:value={displayName} maxlength={LIMITS.displayName.max} placeholder={session.user?.username} />
        </label>
        <p class="muted">Leave this blank to show your username, {session.user?.username}.</p>

        {#if error}<p class="form-error">{error}</p>{/if}
        {#if message}<p class="ok-text">{message}</p>{/if}

        <div class="editor-actions">
          <button type="submit" disabled={busy}>Save</button>
          <button type="button" onclick={() => ui.closeProfile()}>Close</button>
        </div>
      </form>
    </div>
  </div>
</div>
