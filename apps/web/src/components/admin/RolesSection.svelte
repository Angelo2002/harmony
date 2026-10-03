<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Permission,
    namesToPermissions,
    permissionsToNames,
    permissionsToString,
    type PermissionName,
    type Role,
    type RoleBadge,
    type RoleListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { permissionLabel, roleColor } from '../../lib/format';

  const allPermissionNames = Object.keys(Permission) as PermissionName[];

  let roles = $state<Role[]>([]);
  let selectedId = $state<string | null>(null);
  let editName = $state('');
  let editColor = $state('');
  let editPermissions = $state<string[]>([]);
  /** Whether the role gets its own group in the member list. */
  let editHoist = $state(false);
  /** The badge this role confers beside its members' names. */
  let editBadge = $state<RoleBadge>('none');
  let newRoleName = $state('');
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  const selected = $derived(roles.find((role) => role.id === selectedId) ?? null);

  async function load(): Promise<void> {
    const data = await api<RoleListResponse>('/roles');
    roles = data.roles;
    if (selectedId && !roles.some((role) => role.id === selectedId)) selectedId = null;
  }

  function select(role: Role): void {
    selectedId = role.id;
    editName = role.name;
    editColor = role.color == null ? '' : `#${role.color.toString(16).padStart(6, '0')}`;
    editPermissions = permissionsToNames(BigInt(role.permissions));
    editHoist = role.hoist;
    editBadge = role.badge;
    error = null;
    message = null;
  }

  function parseColor(value: string): number | null {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    const hex = match?.[1];
    return hex ? Number.parseInt(hex, 16) : null;
  }

  async function save(): Promise<void> {
    if (!selected) return;
    busy = true;
    error = null;
    message = null;
    try {
      const body: Record<string, unknown> = {
        permissions: permissionsToString(namesToPermissions(editPermissions as PermissionName[])),
      };
      if (!selected.isDefault) {
        body.name = editName.trim();
        body.color = parseColor(editColor);
        body.hoist = editHoist;
        body.badge = editBadge;
      }
      await api(`/roles/${selected.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
      message = 'Role saved.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      const created = await api<Role>('/roles', {
        method: 'POST',
        body: JSON.stringify({ name: newRoleName.trim() }),
      });
      newRoleName = '';
      await load();
      select(created);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (!selected || selected.isDefault) return;
    busy = true;
    try {
      await api(`/roles/${selected.id}`, { method: 'DELETE' });
      selectedId = null;
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function move(role: Role, direction: 'up' | 'down'): Promise<void> {
    busy = true;
    error = null;
    try {
      const data = await api<RoleListResponse>(`/roles/${role.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ direction }),
      });
      roles = data.roles;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });
</script>

<section>
  <h3>Roles</h3>

  <form class="inline" onsubmit={create}>
    <input bind:value={newRoleName} placeholder="New role name" required maxlength="64" />
    <button type="submit" disabled={busy}>Create role</button>
  </form>

  {#if error}<p class="form-error">{error}</p>{/if}

  <div class="split">
    <ul class="rows">
      {#each roles as role, index (role.id)}
        <li class="role-item">
          <button type="button" class="row-main" class:active={role.id === selectedId} onclick={() => select(role)}>
            <span class="swatch" style={`background: ${roleColor(role.color)}`}></span>
            {role.name}
            {#if role.isDefault}<span class="muted">· default</span>{/if}
          </button>
          {#if !role.isDefault}
            <button
              type="button"
              class="move"
              title="Move up"
              disabled={busy || index === 0}
              onclick={() => move(role, 'up')}>↑</button
            >
            <button
              type="button"
              class="move"
              title="Move down"
              disabled={busy || index === roles.length - 1}
              onclick={() => move(role, 'down')}>↓</button
            >
          {/if}
        </li>
      {/each}
    </ul>

    {#if selected}
      <div class="editor">
        <label>
          Name {#if selected.isDefault}<span class="muted">(fixed)</span>{/if}
          <input bind:value={editName} disabled={selected.isDefault} maxlength="64" />
        </label>

        <label>
          Color <span class="muted">(#rrggbb)</span>
          <input bind:value={editColor} placeholder="#5865f2" disabled={selected.isDefault} />
        </label>

        <label class="checkbox">
          <input type="checkbox" bind:checked={editHoist} disabled={selected.isDefault} />
          Show as its own group in the member list
        </label>

        <label>
          Badge shown beside members
          <select bind:value={editBadge} disabled={selected.isDefault}>
            <option value="none">None</option>
            <option value="moderator">Moderator (shield)</option>
          </select>
        </label>

        <fieldset>
          <legend>Permissions</legend>
          <div class="perms">
            {#each allPermissionNames as name (name)}
              <label class="checkbox">
                <input type="checkbox" value={name} bind:group={editPermissions} />
                {permissionLabel(name)}
              </label>
            {/each}
          </div>
        </fieldset>

        {#if message}<p class="ok-text">{message}</p>{/if}

        <div class="editor-actions">
          <button type="button" onclick={save} disabled={busy}>Save</button>
          <button type="button" class="danger" onclick={remove} disabled={busy || selected.isDefault}>Delete</button>
        </div>
      </div>
    {:else}
      <p class="muted">Select a role to edit it.</p>
    {/if}
  </div>
</section>
