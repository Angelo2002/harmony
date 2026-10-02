<script lang="ts">
  import { ALLOWED_IMAGE_TYPES, LIMITS, type MeResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');

  let displayName = $state(session.user?.displayName ?? '');
  let showTyping = $state(session.user?.showTyping ?? true);
  let notifyMajor = $state(session.user?.notifyMajor ?? true);
  let notifyMinor = $state(session.user?.notifyMinor ?? true);
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  let soundError = $state<string | null>(null);
  let soundMessage = $state<string | null>(null);
  let savingSounds = $state(false);

  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordError = $state<string | null>(null);
  let passwordMessage = $state<string | null>(null);
  let changingPassword = $state(false);

  let discordBusy = $state(false);
  let discordError = $state<string | null>(null);
  let discordMessage = $state<string | null>(null);

  const picture = $derived(avatarUrl(session.user));

  type Tab = 'profile' | 'notifications' | 'password';
  let tab = $state<Tab>('profile');

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'password', label: 'Password' },
  ];

  function apply(data: MeResponse): void {
    session.user = data.user;
    session.permissions = data.permissions;
    displayName = data.user.displayName ?? '';
    showTyping = data.user.showTyping;
    notifyMajor = data.user.notifyMajor;
    notifyMinor = data.user.notifyMinor;
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

  async function saveSounds(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    savingSounds = true;
    soundError = null;
    soundMessage = null;
    try {
      apply(
        await api<MeResponse>('/users/@me', {
          method: 'PATCH',
          body: JSON.stringify({ notifyMajor, notifyMinor }),
        }),
      );
      soundMessage = 'Notification sounds saved.';
    } catch (cause) {
      soundError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      savingSounds = false;
    }
  }

  async function disconnectDiscord(): Promise<void> {
    discordBusy = true;
    discordError = null;
    discordMessage = null;
    try {
      await api('/users/@me/discord', { method: 'DELETE' });
      apply(await api<MeResponse>('/auth/me'));
      discordMessage = 'Discord disconnected.';
    } catch (cause) {
      discordError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      discordBusy = false;
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
    <nav class="admin-nav">
      <h2>Your account</h2>
      {#each TABS as entry (entry.id)}
        <button class="admin-tab" class:active={tab === entry.id} type="button" onclick={() => (tab = entry.id)}>
          {entry.label}
        </button>
      {/each}
      <button class="admin-close" type="button" onclick={() => ui.closeProfile()}>Close</button>
    </nav>

    <div class="admin-body">
      {#if tab === 'profile'}
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
          </div>
        </form>

        <div class="panel">
          <h2>Discord</h2>
          {#if session.user?.discordId}
            <p>Connected to <code>{session.user.discordId}</code>.</p>
            <p class="muted">
              You are pinged on Discord when someone mentions you here, and your Discord messages
              appear under this account.
            </p>
            <div class="editor-actions">
              <button type="button" class="danger" onclick={disconnectDiscord} disabled={discordBusy}>
                Disconnect
              </button>
            </div>
          {:else if meta.discordAuthEnabled}
            <p class="muted">
              Connect your Discord account so mentions here reach you there, and your Discord
              messages appear under this account.
            </p>
            <a class="button-link" href="/api/v1/auth/discord?intent=link">
              <Icon name="link" size={16} /> Connect Discord
            </a>
          {:else}
            <p class="muted">An administrator can link your Discord account to this one.</p>
          {/if}
          {#if discordError}<p class="form-error">{discordError}</p>{/if}
          {#if discordMessage}<p class="ok-text">{discordMessage}</p>{/if}
        </div>
      {:else if tab === 'notifications'}
        <h3>Notifications</h3>

        <form onsubmit={saveSounds}>
          <label class="checkbox">
            <input type="checkbox" bind:checked={notifyMajor} />
            Someone mentions me
          </label>
          <p class="muted">
            The louder sound, for a reply to one of your messages or a message that names you.
          </p>

          <label class="checkbox">
            <input type="checkbox" bind:checked={notifyMinor} />
            New messages in the channel I am reading
          </label>
          <p class="muted">The quieter sound. Messages in other channels stay silent.</p>

          <p class="muted">
            Sounds only play while Harmony is open in a tab or window. Nothing is ever sent to your phone or
            desktop.
          </p>

          {#if soundError}<p class="form-error">{soundError}</p>{/if}
          {#if soundMessage}<p class="ok-text">{soundMessage}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={savingSounds}>Save</button>
          </div>
        </form>
      {:else}
        <h3>Change password</h3>

        <form onsubmit={changePassword}>
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
            <button type="submit" disabled={changingPassword || !currentPassword || !newPassword}>
              Change password
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
</div>
