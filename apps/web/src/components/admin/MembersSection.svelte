<script lang="ts">
  import { onMount } from 'svelte';
  import type { MemberListResponse, MemberSummary, Role, RoleListResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { roleColor } from '../../lib/format';

  let members = $state<MemberSummary[]>([]);
  let roles = $state<Role[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // The bridge creates a stand-in account for every Discord user it sees, which
  // would drown out real members, so they are kept in their own collapsible group.
  const humanMembers = $derived(members.filter((member) => !member.user.isBot));
  const bridgeMembers = $derived(members.filter((member) => member.user.isBot));

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

  async function assign(userId: string, roleId: string): Promise<void> {
    if (!roleId) return;
    busy = true;
    try {
      await api(`/members/${userId}/roles/${roleId}`, { method: 'PUT' });
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function unassign(userId: string, roleId: string): Promise<void> {
    busy = true;
    try {
      await api(`/members/${userId}/roles/${roleId}`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Members</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#snippet memberRow(member: MemberSummary)}
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
