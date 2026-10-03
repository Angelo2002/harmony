import { MEMBER_MANAGEMENT_PERMISSIONS, Permission, hasAnyPermission, type PermissionValue } from '@harmony/shared';

export type AdminTabId =
  | 'settings'
  | 'roles'
  | 'members'
  | 'channels'
  | 'emojis'
  | 'media'
  | 'retention'
  | 'bridge'
  | 'invites'
  | 'bans'
  | 'audit';

/**
 * Every admin tab, with the permissions that unlock it. A tab shows when the
 * member holds any one of them, so the Members tab reaches both a role manager
 * and a plain moderator. This list is the single source of truth: the sidebar
 * button and the panel both read from it, so they cannot disagree about who
 * should see what.
 */
export const ADMIN_TABS: ReadonlyArray<{
  id: AdminTabId;
  label: string;
  permissions: readonly PermissionValue[];
}> = [
  { id: 'settings', label: 'Settings', permissions: [Permission.ManageServer] },
  { id: 'roles', label: 'Roles', permissions: [Permission.ManageRoles] },
  { id: 'members', label: 'Members', permissions: MEMBER_MANAGEMENT_PERMISSIONS },
  { id: 'channels', label: 'Channels', permissions: [Permission.ManageChannels] },
  { id: 'emojis', label: 'Emojis', permissions: [Permission.ManageEmojis] },
  { id: 'media', label: 'Media', permissions: [Permission.ManageServer] },
  { id: 'retention', label: 'Retention', permissions: [Permission.ManageServer] },
  { id: 'bridge', label: 'Bridge', permissions: [Permission.ManageServer] },
  { id: 'invites', label: 'Invites', permissions: [Permission.ManageServer] },
  { id: 'bans', label: 'Bans', permissions: [Permission.BanMembers] },
  { id: 'audit', label: 'Log', permissions: [Permission.ManageServer] },
];

/** The tabs a member may open, in the order they are shown. */
export function visibleAdminTabs(granted: PermissionValue): ReadonlyArray<(typeof ADMIN_TABS)[number]> {
  return ADMIN_TABS.filter((tab) => hasAnyPermission(granted, tab.permissions));
}

/** Whether the member can open the admin panel at all, for any reason. */
export function canOpenAdminPanel(granted: PermissionValue): boolean {
  return ADMIN_TABS.some((tab) => hasAnyPermission(granted, tab.permissions));
}
