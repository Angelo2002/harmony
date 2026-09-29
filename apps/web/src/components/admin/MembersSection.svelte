<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Permission,
    hasPermission,
    isTimedOut,
    type MemberListResponse,
    type MemberSummary,
    type Role,
    type RoleListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { roleColor } from '../../lib/format';
  import { session } from '../../lib/session.svelte';

  let members = $state<MemberSummary[]>([]);
  let roles = $state<Role[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // The bridge creates a stand-in account for every Discord user it sees, which
  // would drown out real members, so they are kept in their own collapsible group.
  const humanMembers = $derived(members.filter((member) => !member.user.isBot));
  const bridgeMembers = $derived(members.filter((member) => member.user.isBot));

  const permissions = $derived(BigInt(session.permissions || '0'));
  const canTimeout = $derived(hasPermission(permissions, Permission.ModerateMembers));
  const canKick = $derived(hasPermission(permissions, Permission.KickMembers));
  const canBan = $derived(hasPermission(permissions, Permission.BanMembers));

  const timeoutPresets = [
    { minutes: 1, label: '1 minute' },
    { minutes: 5, label: '5 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: 1440, label: '1 day' },
    { minutes: 10080, label: '1 week' },
  ];

  async function load(): Promise<void> {
    const [memberData, roleData] = await Promise.all([
      api<MemberListResponse>('/members'),
      api<RoleListResponse>('/roles'),
    ]);
    members = memberData.members;
    roles = roleData.roles;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  function roleById(id: string): Role | undefined {
    return roles.find((role) => role.id === id);
  }

  function assignable(member: MemberSummary): Role[] {
    const assigned = new Set(member.roleIds);
    return roles.filter((role) => !role.isDefault && !assigned.has(role.id));
  }

  /** Nobody may moderate themselves, a stand-in, or another administrator. */
  function moderatable(member: MemberSummary): boolean {
    if (member.user.isBot) return false;
    if (member.user.id === session.user?.id) return false;
    return !hasPermission(BigInt(member.permissions), Permission.Administrator);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = null;
    try {
      await action();
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function assign(userId: string, roleId: string): Promise<void> {
    if (!roleId) return;
    await run(() => api(`/members/${userId}/roles/${roleId}`, { method: 'PUT' }));
  }

  async function unassign(userId: string, roleId: string): Promise<void> {
    await run(() => api(`/members/${userId}/roles/${roleId}`, { method: 'DELETE' }));
  }

  function setTimeoutLength(userId: string, minutes: number): void {
    void run(() =>
      api(`/members/${userId}/timeout`, {
        method: 'PUT',
        body: JSON.stringify({ durationMinutes: minutes }),
      }),
    );
  }

  function clearTimeout(userId: string): void {
    void run(() => api(`/members/${userId}/timeout`, { method: 'DELETE' }));
  }

  function kick(member: MemberSummary): void {
    const name = member.user.displayName ?? member.user.username;
    if (!confirm(`Kick ${name}? They are logged out and can sign back in.`)) return;
    void run(() => api(`/members/${member.user.id}/kick`, { method: 'POST' }));
  }

  function ban(member: MemberSummary): void {
    const name = member.user.displayName ?? member.user.username;
    const reason = prompt(`Ban ${name}? They will not be able to sign in again. Optionally give a reason.`);
    if (reason === null) return;
    void run(() =>
      api(`/members/${member.user.id}/ban`, {
        method: 'PUT',
        body: JSON.stringify({ reason: reason.trim() || null }),
      }),
    );
  }
</script>

<section>
  <h3>Members</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#snippet memberRow(member: MemberSummary)}
    {@const timeoutLabel =
      isTimedOut(member.user) && member.user.timedOutUntil
        ? new Date(member.user.timedOutUntil).toLocaleString()
        : null}
    <li class="member">
      <div class="member-head">
        <strong>{member.user.displayName ?? member.user.username}</strong>
        {#if member.user.displayName}<span class="muted">@{member.user.username}</span>{/if}
        {#if member.user.isOwner}<span class="badge">owner</span>{/if}
      </div>

      <div class="member-roles">
        {#each member.roleIds as roleId (roleId)}
          {@const role = roleById(roleId)}
          {#if role}
            <span class="chip">
              <span class="swatch" style={`background: ${roleColor(role.color)}`}></span>{role.name}
              <button
                type="button"
                class="chip-remove"
                title="Remove role"
                onclick={() => unassign(member.user.id, roleId)}>×</button
              >
            </span>
          {/if}
        {/each}

        <select
          disabled={busy || assignable(member).length === 0}
          onchange={(event) => {
            const element = event.currentTarget as HTMLSelectElement;
            void assign(member.user.id, element.value);
            element.value = '';
          }}
        >
          <option value="">Add role…</option>
          {#each assignable(member) as role (role.id)}
            <option value={role.id}>{role.name}</option>
          {/each}
        </select>
      </div>

      {#if moderatable(member)}
        <div class="member-moderation">
          {#if timeoutLabel}
            <span class="muted">Timed out until {timeoutLabel}</span>
            {#if canTimeout}
              <button type="button" onclick={() => clearTimeout(member.user.id)} disabled={busy}>
                Clear timeout
              </button>
            {/if}
          {:else if canTimeout}
            <select
              disabled={busy}
              onchange={(event) => {
                const element = event.currentTarget as HTMLSelectElement;
                const minutes = Number(element.value);
                element.value = '';
                if (minutes > 0) setTimeoutLength(member.user.id, minutes);
              }}
            >
              <option value="">Timeout…</option>
              {#each timeoutPresets as preset (preset.minutes)}
                <option value={preset.minutes}>{preset.label}</option>
              {/each}
            </select>
          {/if}

          {#if canKick}
            <button type="button" onclick={() => kick(member)} disabled={busy}>Kick</button>
          {/if}
          {#if canBan}
            <button type="button" class="danger" onclick={() => ban(member)} disabled={busy}>Ban</button>
          {/if}
        </div>
      {/if}
    </li>
  {/snippet}

  <ul class="rows">
    {#each humanMembers as member (member.user.id)}
      {@render memberRow(member)}
    {/each}
  </ul>

  {#if bridgeMembers.length > 0}
    <details class="member-group">
      <summary>Discord accounts <span class="muted">({bridgeMembers.length})</span></summary>
      <p class="muted">
        Stand-in accounts the bridge creates for people on Discord. They are listed here only so
        their roles and colours can be managed.
      </p>
      <ul class="rows">
        {#each bridgeMembers as member (member.user.id)}
          {@render memberRow(member)}
        {/each}
      </ul>
    </details>
  {/if}
</section>
