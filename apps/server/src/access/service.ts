import type { DatabaseSync } from 'node:sqlite';
import { Permission, hasPermission } from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { findCategory, listCategories, type CategoryRow } from '../db/categories.ts';
import { findChannel, listChannels, type ChannelRow } from '../db/channels.ts';
import { listRoleIdsForUser } from '../db/roles.ts';
import { findUserById } from '../db/users.ts';

/**
 * Channel locking, kept deliberately simple: a channel or category may require
 * one role, and administrators always see everything.
 *
 * Nothing here is hierarchical. A channel with no role of its own inherits its
 * category's, so locking a category covers everything inside it, and a channel
 * can tighten that further but never loosen it.
 */

/** What a member may see, resolved once and reused for a whole request. */
export interface ChannelAccess {
  /** True for administrators, who bypass every requirement. */
  bypass: boolean;
  /** The role ids the member holds. */
  roleIds: ReadonlySet<string>;
}

/** How a resource is protected, for deciding whether an event may be sent to one member. */
export interface ResourceVisibility {
  channelId?: string;
  categoryId?: string;
}

export function channelAccessFor(sqlite: DatabaseSync, userId: string): ChannelAccess {
  const user = findUserById(sqlite, userId);
  if (!user) return { bypass: false, roleIds: new Set() };
  return {
    bypass: hasPermission(resolvePermissions(sqlite, user), Permission.Administrator),
    roleIds: new Set(listRoleIdsForUser(sqlite, userId)),
  };
}

/** The role a channel demands: its own, or the one its category demands. */
export function requiredRoleForChannel(sqlite: DatabaseSync, channel: ChannelRow): string | null {
  if (channel.required_role_id) return channel.required_role_id;
  if (!channel.category_id) return null;
  return findCategory(sqlite, channel.category_id)?.required_role_id ?? null;
}

/** Categories a member may see. */
export function visibleCategories(sqlite: DatabaseSync, access: ChannelAccess): CategoryRow[] {
  const categories = listCategories(sqlite);
  if (access.bypass) return categories;
  return categories.filter(
    (category) => category.required_role_id === null || access.roleIds.has(category.required_role_id),
  );
}

/**
 * Channels a member may see, in display order. A channel is hidden when its own
 * role, or the one it inherits, is missing, and also when its category is
 * hidden, so no channel is ever left without a home in the sidebar.
 */
export function visibleChannels(sqlite: DatabaseSync, access: ChannelAccess): ChannelRow[] {
  const channels = listChannels(sqlite);
  if (access.bypass) return channels;

  const categories = new Map(listCategories(sqlite).map((category) => [category.id, category]));
  return channels.filter((channel) => {
    const category = channel.category_id ? categories.get(channel.category_id) : undefined;
    if (category?.required_role_id && !access.roleIds.has(category.required_role_id)) return false;
    const needed = channel.required_role_id ?? category?.required_role_id ?? null;
    return needed === null || access.roleIds.has(needed);
  });
}

/** Whether a member may read or post in one channel. */
export function canAccessChannel(
  sqlite: DatabaseSync,
  access: ChannelAccess,
  channelId: string,
): boolean {
  const channel = findChannel(sqlite, channelId);
  if (!channel) return false;
  if (access.bypass) return true;

  if (channel.category_id) {
    const category = findCategory(sqlite, channel.category_id);
    if (category?.required_role_id && !access.roleIds.has(category.required_role_id)) return false;
  }
  const needed = requiredRoleForChannel(sqlite, channel);
  return needed === null || access.roleIds.has(needed);
}

/**
 * Whether a member may be told about a channel or category. Used to keep gateway
 * traffic for a locked channel away from members who cannot see it.
 */
export function canSeeResource(
  sqlite: DatabaseSync,
  access: ChannelAccess,
  visibility: ResourceVisibility,
): boolean {
  if (access.bypass) return true;

  if (visibility.categoryId !== undefined) {
    const category = findCategory(sqlite, visibility.categoryId);
    // A category that is already gone has nothing left to hide.
    return !category?.required_role_id || access.roleIds.has(category.required_role_id);
  }
  if (visibility.channelId !== undefined) {
    return canAccessChannel(sqlite, access, visibility.channelId);
  }
  return true;
}
