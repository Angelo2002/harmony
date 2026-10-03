<script lang="ts">
  import type { UserBadge } from '@harmony/shared';
  import Icon from './Icon.svelte';

  /** A small crown, sword or shield shown beside a member's name. */
  let { badge, size = 15 }: { badge: UserBadge; size?: number } = $props();

  const ICON = { owner: 'crown', admin: 'sword', moderator: 'shield' } as const;
  const LABEL = { owner: 'Owner', admin: 'Administrator', moderator: 'Moderator' } as const;
</script>

<span class={`member-badge badge-${badge}`} title={LABEL[badge]}>
  <Icon name={ICON[badge]} size={size} />
</span>
