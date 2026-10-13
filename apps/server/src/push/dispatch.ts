import type { DatabaseSync } from 'node:sqlite';
import {
  resolveChannelSettings,
  type Message,
  type PushPayload,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { findChannelSettings, toChannelSettings } from '../db/channel_settings.ts';
import { findChannel } from '../db/channels.ts';
import { listMentionsForMessage } from '../db/mentions.ts';
import { deletePushDevice, listPushDevices } from '../db/push_devices.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import type { PushSender } from './sender.ts';

/** How much of a message travels in the notification text. */
const SNIPPET_MAX = 80;

export interface PushDispatchDeps {
  sqlite: DatabaseSync;
  /** Only `onlineUserIds` is read: a member already connected is not also pushed. */
  hub: Pick<GatewayHub, 'onlineUserIds'>;
  settings: Pick<SettingsService, 'get' | 'getInstanceId' | 'getIconHash' | 'getBridgePublic'>;
  sender: PushSender;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected by tests so a mute can be judged against a fixed clock. */
  now?: () => number;
}

export interface PushDispatcher {
  /**
   * Fans one live message out to the devices of everyone it named or answered.
   * Best-effort and never throwing: it is called after the message is stored and
   * broadcast, and a stuck provider must not affect either.
   */
  notify(message: Message): void;
}

/** A short, single-line preview of the text, or null for a bare attachment. */
function snippetOf(content: string): string | null {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  const points = Array.from(flat);
  // Slice by code point so an emoji at the boundary is not cut in half.
  return points.length > SNIPPET_MAX ? `${points.slice(0, SNIPPET_MAX - 1).join('')}…` : flat;
}

/**
 * Turns a live message into a push per recipient, honouring the same mute and
 * notification level the inbox and the in-app sound use, and skipping anyone who
 * is connected right now. The recipients are the `mentions` rows, so a member is
 * told once per message however many times it names them, and an edit or a
 * history backfill never reaches here at all.
 *
 * Delivery is best-effort and off the request path: a send is fired and
 * forgotten, and only a definite "gone" prunes the registration. The endpoint is
 * a capability, so a failure is logged by member and reason, never by URL.
 */
export function createPushDispatcher(deps: PushDispatchDeps): PushDispatcher {
  const { sqlite } = deps;

  function channelSettingsFor(userId: string, channelId: string, categoryId: string | null, now: number) {
    const own = findChannelSettings(sqlite, userId, { type: 'channel', id: channelId });
    const category = categoryId === null ? undefined : findChannelSettings(sqlite, userId, { type: 'category', id: categoryId });
    return resolveChannelSettings(
      own ? toChannelSettings(own, now) : undefined,
      category ? toChannelSettings(category, now) : undefined,
      now,
    );
  }

  function iconUrl(): string | null {
    const base = deps.settings.getBridgePublic().publicBaseUrl;
    if (!base) return null;
    // The operator's declared public address is the only origin the server knows
    // for itself; without one the client falls back to the name in the tray.
    const root = base.replace(/\/+$/, '');
    const hash = deps.settings.getIconHash();
    return hash ? `${root}/api/v1/icons/128?v=${encodeURIComponent(hash)}` : `${root}/api/v1/icons/128`;
  }

  function deliver(userId: string, payload: PushPayload): void {
    for (const device of listPushDevices(sqlite, userId)) {
      void deps.sender
        .send(device.endpoint, payload)
        .then((result) => {
          if (result.ok) return;
          if (result.gone) {
            // The provider says the endpoint no longer exists, so it is pruned
            // rather than retried on every future mention.
            deletePushDevice(sqlite, userId, device.endpoint);
            deps.log?.('push_endpoint_pruned', { userId });
            return;
          }
          deps.log?.('push_delivery_failed', { userId, error: result.error });
        })
        .catch((error: unknown) => {
          deps.log?.('push_delivery_failed', {
            userId,
            error: error instanceof Error ? error.name : 'unknown',
          });
        });
    }
  }

  return {
    notify(message) {
      try {
        const recipients = listMentionsForMessage(sqlite, message.id);
        if (recipients.length === 0) return;

        const now = deps.now?.() ?? Date.now();
        const online = deps.hub.onlineUserIds();
        const channel = findChannel(sqlite, message.channelId);
        const instanceId = deps.settings.getInstanceId();
        const instanceName = deps.settings.get().serverName;
        const icon = iconUrl();
        const authorName = (message.author?.displayName ?? '').trim() || message.author?.username || '';
        const snippet = snippetOf(message.content);
        const channelName = channel?.name ?? '';

        for (const recipient of recipients) {
          // A member already holding a gateway connection sees the message live,
          // so a push would only be a second, later copy of the same news.
          if (online.has(recipient.userId)) continue;

          // A mention row is written for anyone the message names or answers,
          // whether or not they can see the channel, and its snippet is message
          // text. The inbox already asks only about the channels a member can
          // see, so a locked channel never reaches them there; the fan-out must
          // hold to the same predicate or a notification would leak the snippet
          // of a channel the recipient is not allowed to read.
          if (!canAccessChannel(sqlite, channelAccessFor(sqlite, recipient.userId), message.channelId)) continue;

          const settings = channelSettingsFor(recipient.userId, message.channelId, channel?.category_id ?? null, now);
          if (settings.muted || settings.level === 'nothing') continue;

          deliver(recipient.userId, {
            instanceId,
            instanceName,
            iconUrl: icon,
            channelId: message.channelId,
            channelName,
            messageId: message.id,
            kind: recipient.kind,
            authorName,
            snippet,
          });
        }
      } catch (error) {
        // A push is a side show: it must never disturb the message that caused it.
        deps.log?.('push_fanout_failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    },
  };
}
