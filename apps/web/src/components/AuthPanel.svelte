<script lang="ts">
  import type { AuthResponse, MeResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';

  let mode = $state<'login' | 'register'>('login');
  let username = $state('');
  let password = $state('');
  let inviteCode = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  function switchMode(next: 'login' | 'register') {
    mode = next;
    error = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    busy = true;
    try {
      const body =
        mode === 'login'
          ? { username, password }
          : { username, password, inviteCode: inviteCode.trim() || undefined };

      await api<AuthResponse>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) });

      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <header>
    <h1>{meta.serverName}</h1>
    <p class="muted">
      {#if mode === 'login'}
        Welcome back.
      {:else if meta.requireInvite}
        Create your account — an invite code is required.
      {:else}
        Create your account.
      {/if}
    </p>
  </header>

  <form onsubmit={submit}>
    <label>
      Username
      <input name="username" bind:value={username} autocomplete="username" required />
    </label>

    <label>
      Password
      <input
        name="password"
        type="password"
        bind:value={password}
        autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
        required
      />
    </label>

    {#if mode === 'register'}
      <label>
        Invite code <span class="optional">{meta.requireInvite ? '(required)' : '(if required)'}</span>
        <input name="inviteCode" bind:value={inviteCode} autocomplete="off" required={meta.requireInvite} />
      </label>
    {/if}

    {#if error}
      <p class="form-error">{error}</p>
    {/if}

    <button type="submit" disabled={busy}>
      {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Register'}
    </button>
  </form>

  <p class="switch">
    {#if mode === 'login'}
      No account yet?
      <button type="button" class="link" onclick={() => switchMode('register')}>Register</button>
    {:else}
      Already have an account?
      <button type="button" class="link" onclick={() => switchMode('login')}>Log in</button>
    {/if}
  </p>
</main>
