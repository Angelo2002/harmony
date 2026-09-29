<script lang="ts">
  import { ALLOWED_IMAGE_TYPES, LIMITS, type MeResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');

  let displayName = $state(session.user?.displayName ?? '');
  let showTyping = $state(session.user?.showTyping ?? true);
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordError = $state<string | null>(null);
  let passwordMessage = $state<string | null>(null);
  let changingPassword = $state(false);

  const picture = $derived(avatarUrl(session.user));

  function apply(data: MeResponse): void {
    session.user = data.user;
    session.permissions = data.permissions;
    displayName = data.user.displayName ?? '';
    showTyping = data.user.showTyping;
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
          body: JSON.stringify({ displayName: displayName.trim() || null, showTyping }),
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

  async function changePassword(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    passwordError = null;
    passwordMessage = null;
    if (newPassword !== confirmPassword) {
      passwordError = 'The two new passwords do not match.';
      return;
    }

    changingPassword = true;
    try {
      await api('/users/@me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      passwordMessage = 'Password changed. Your other devices have been signed out.';
    } catch (cause) {
      passwordError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      changingPassword = false;
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

        <label class="checkbox">
          <input type="checkbox" bind:checked={showTyping} />
          Typing indicators
        </label>
        <p class="muted">See when other people are typing, and let them see when you are.</p>

        {#if error}<p class="form-error">{error}</p>{/if}
        {#if message}<p class="ok-text">{message}</p>{/if}

        <div class="editor-actions">
          <button type="submit" disabled={busy}>Save</button>
          <button type="button" onclick={() => ui.closeProfile()}>Close</button>
        </div>
      </form>

      <form onsubmit={changePassword}>
        <h4 class="profile-section-title">Change password</h4>

        <label>
          Current password
          <input
            type="password"
            bind:value={currentPassword}
            autocomplete="current-password"
            maxlength={LIMITS.password.max}
          />
        </label>

        <label>
          New password
          <input
            type="password"
            bind:value={newPassword}
            autocomplete="new-password"
            minlength={LIMITS.password.min}
            maxlength={LIMITS.password.max}
          />
        </label>

        <label>
          Confirm new password
          <input
            type="password"
            bind:value={confirmPassword}
            autocomplete="new-password"
            minlength={LIMITS.password.min}
            maxlength={LIMITS.password.max}
          />
        </label>

        <p class="muted">Changing your password signs out every other device. Ask an admin if you have forgotten it.</p>

        {#if passwordError}<p class="form-error">{passwordError}</p>{/if}
        {#if passwordMessage}<p class="ok-text">{passwordMessage}</p>{/if}

        <div class="editor-actions">
          <button type="submit" disabled={changingPassword || !currentPassword || !newPassword}>Change password</button>
        </div>
      </form>
    </div>
  </div>
</div>
