import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  isMuteActive,
  updateChannelSettingsSchema,
  type ChannelNotificationSettings,
  type ChannelSettingsListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { channelAccessFor, visibleCategories, visibleChannels } from '../access/service.ts';
import {
  findChannelSettings,
  listChannelSettings,
  saveChannelSettings,
  toChannelSettings,
  type SettingsTarget,
} from '../db/channel_settings.ts';
import type { Database } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface ChannelSettingsRouteDeps {
  db: Database;
  hub: GatewayHub;
}

/**
 * A member's own mute and notification settings for channels and categories.
 * They are nobody else's business, so there is no way to read anyone else's and
 * a change is announced only to the member's own other sessions.
 */
export function registerChannelSettingsRoutes(app: FastifyInstance, deps: ChannelSettingsRouteDeps): void {
  const { db, hub } = deps;

  /** The channels and categories this member can currently see, by id. */
  function visibleTargets(userId: string): Map<string, SettingsTarget['type']> {
    const access = channelAccessFor(db.sqlite, userId);
    const targets = new Map<string, SettingsTarget['type']>();
    for (const category of visibleCategories(db.sqlite, access)) targets.set(category.id, 'category');
    for (const channel of visibleChannels(db.sqlite, access)) targets.set(channel.id, 'channel');
    return targets;
  }

  app.get('/api/v1/users/@me/channel-settings', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    // A setting on something since locked away stays stored, in case access
    // comes back, but is not reported: it would only name a channel they cannot see.
    const visible = visibleTargets(auth.user.id);
    const now = Date.now();
    const body: ChannelSettingsListResponse = {
      settings: listChannelSettings(db.sqlite, auth.user.id)
        .map((row) => toChannelSettings(row, now))
        .filter((settings) => visible.get(settings.targetId) === settings.targetType),
    };
    return body;
  });

  /**
   * Changes the caller's settings for one channel or category, whichever the id
   * names. Fields left out keep their current value. An id the caller cannot see
   * is answered exactly like one that does not exist, so this cannot be used to
   * probe for locked channels.
   */
  app.put('/api/v1/users/@me/channel-settings/:targetId', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { targetId } = request.params as { targetId: string };
    const type = visibleTargets(auth.user.id).get(targetId);
    if (!type) throw new HttpError(404, 'target_not_found', 'That channel or category does not exist.');
    const input = parseBody(updateChannelSettingsSchema, request.body);

    const target: SettingsTarget = { type, id: targetId };
    const existing = findChannelSettings(db.sqlite, auth.user.id, target);
    const now = Date.now();
    const current: ChannelNotificationSettings = existing
      ? toChannelSettings(existing, now)
      : { targetId, targetType: type, muted: false, muteEndsAt: null, level: 'default' };

    let { muted, muteEndsAt } = current;
    if (input.muted === true) {
      muted = true;
      // The end is worked out here from a length rather than taken from the
      // client, so a device with a wrong clock still mutes for as long as asked.
      muteEndsAt = input.muteSeconds == null ? null : new Date(now + input.muteSeconds * 1000).toISOString();
    } else if (input.muted === false) {
      muted = false;
      muteEndsAt = null;
    }
    const level = input.level ?? current.level;

    saveChannelSettings(db.sqlite, auth.user.id, target, {
      muted,
      muteEndsAt,
      level,
      updatedAt: new Date(now).toISOString(),
    });

    const settings: ChannelNotificationSettings = {
      targetId,
      targetType: type,
      muted: isMuteActive({ muted, muteEndsAt }, now),
      muteEndsAt: muted ? muteEndsAt : null,
      level,
    };
    // Only the member's own sessions hear about it, on every device they have open.
    hub.dispatchToUsers(GatewayEvent.ChannelSettingsUpdate, settings, new Set([auth.user.id]));
    return settings;
  });
}
