<script lang="ts">
  import type { MemberRosterEntry, Role } from '@harmony/shared';
  import { avatarUrl, initial } from '../lib/avatar';
  import { profileCard } from '../lib/profile-card.svelte';
  import { roster } from '../lib/roster.svelte';
  import { ui } from '../lib/ui.svelte';

  interface Group {
    key: string;
    label: string;
    color: number | null;
    members: MemberRosterEntry[];
  }

  function nameOf(entry: MemberRosterEntry): string {
    return entry.user.displayName ?? entry.user.username;
  }

  function byName(a: MemberRosterEntry, b: MemberRosterEntry): number {
    return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
  }

  /** The highest hoisted role a member holds, or null when they hold none. */
  function hoistedRole(entry: MemberRosterEntry, byId: Map<string, Role>): Role | null {
    let best: Role | null = null;
    for (const roleId of entry.roleIds) {
      const role = byId.get(roleId);
      if (!role || !role.hoist || role.isDefault) continue;
      if (!best || role.position > best.position) best = role;
    }
    return best;
  }

  function cssColor(value: number | null): string {
    return value == null ? '' : `#${value.toString(16).padStart(6, '0')}`;
  }

  const groups = $derived.by((): Group[] => {
    const byId = new Map(roster.roles.map((role) => [role.id, role]));
    // Discord stand-in accounts are never really present, so they would only
    // pad the offline list; they are left out of the roster on purpose.
    const humans = roster.members.filter((entry) => !entry.user.isBot);
    const online = humans.filter((entry) => entry.online);
    const offline = humans.filter((entry) => !entry.online);

    const result: Group[] = [];

    // Hoisted roles come first, highest position first, each with its own
    // section. Members holding no hoisted role fall into a plain "Online" group
    // underneath them, then everyone who is offline.
    const hoisted = roster.roles
      .filter((role) => role.hoist && !role.isDefault)
      .sort((a, b) => b.position - a.position);
    for (const role of hoisted) {
      const group = online.filter((entry) => hoistedRole(entry, byId)?.id === role.id).sort(byName);
      if (group.length > 0) result.push({ key: role.id, label: role.name, color: role.color, members: group });
    }

    const ungrouped = online.filter((entry) => hoistedRole(entry, byId) === null).sort(byName);
    if (ungrouped.length > 0) result.push({ key: 'online', label: 'Online', color: null, members: ungrouped });

    if (offline.length > 0) {
      result.push({ key: 'offline', label: 'Offline', color: null, members: offline.sort(byName) });
    }
    return result;
  });
</script>

<aside class="roster" class:open={ui.rosterOpen} aria-label="Members">
  {#if groups.length === 0}
    <p class="muted roster-empty">No members yet.</p>
  {:else}
    {#each groups as group (group.key)}
      <div class="roster-group">
        <span class="roster-group-name" style={cssColor(group.color)}>
          {group.label} — {group.members.length}
        </span>
        {#each group.members as entry (entry.user.id)}
          <button
            type="button"
            class="roster-member profile-trigger"
            class:offline={!entry.online}
            onmouseenter={(event) => profileCard.show(entry.user, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
            onfocus={(event) => profileCard.show(entry.user, event.currentTarget)}
            onblur={() => profileCard.scheduleHide()}
            onclick={(event) => profileCard.show(entry.user, event.currentTarget, true)}
          >
            {#if avatarUrl(entry.user)}
              <img class="avatar small" src={avatarUrl(entry.user)} alt="" loading="lazy" />
            {:else}
              <span class="avatar small fallback">{initial(entry.user)}</span>
            {/if}
            <span class="roster-name" style={cssColor(entry.user.roleColor)}>{nameOf(entry)}</span>
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</aside>
