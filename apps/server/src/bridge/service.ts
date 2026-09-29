import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeResponse, DiscordChannelListResponse, Message } from '@harmony/shared';
import { findChannel, findChannelByDiscordId, setChannelWebhook, type ChannelRow } from '../db/channels.ts';
import { insertBridgeMessage } from '../db/bridge.ts';
import { findUserByDiscordId, insertGhostUser, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { SettingsService } from '../settings/service.ts';
import type {
  BridgeLogger,
  DiscordIncomingMessage,
  DiscordTransport,
  MirrorResult,
  WebhookRef,
} from './transport.ts';

export interface BridgeService {
  status(): BridgeResponse;
  /** Starts, stops or restarts the bot to match the saved settings. */
  applySettings(): Promise<void>;
  listDiscordChannels(): Promise<DiscordChannelListResponse>;
  /** Sends a test message so an admin can verify a mapping and see any error. */
  testMirror(channelId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BridgeDeps {
  sqlite: DatabaseSync;
  settings: SettingsService;
  messages: MessageService;
  logger: BridgeLogger;
  transportFactory: (token: string, logger: BridgeLogger) => DiscordTransport;
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const { logger } = deps;
  let transport: DiscordTransport | null = null;
  let activeToken: string | null = null;

  function status(): BridgeResponse {
    const config = deps.settings.getBridgePublic();
    return {
      configured: config.configured,
      enabled: config.enabled,
      status: transport?.status() ?? { ready: false, botTag: null, guildName: null, error: null },
    };
  }

  /** Finds the stand-in account for a Discord author, creating it on first sight. */
  function resolveGhostUser(message: DiscordIncomingMessage): UserRow {
    const existing = findUserByDiscordId(deps.sqlite, message.authorId);
    if (existing) return existing;

    const id = randomUUID();
    insertGhostUser(deps.sqlite, {
      id,
      // Never shown: the display name carries what users actually see.
      username: `discord_${message.authorId}`,
      displayName: message.authorName,
      discordId: message.authorId,
      createdAt: new Date().toISOString(),
    });

    const created = findUserByDiscordId(deps.sqlite, message.authorId);
    if (!created) throw new Error('Failed to create the bridged user');
    return created;
  }

  async function ingest(message: DiscordIncomingMessage): Promise<void> {
    // Ignore bots, including our own mirrored webhook messages.
    if (message.fromBot) return;

    const channel = findChannelByDiscordId(deps.sqlite, message.channelId);
    if (!channel) return;

    const author = resolveGhostUser(message);
    deps.messages.createBridged(channel.id, author.id, message.content);
  }

  /** Shared by normal mirroring and the admin's test message. */
  async function sendToDiscord(channel: ChannelRow, username: string, content: string): Promise<MirrorResult> {
    if (!transport) {
      throw new HttpError(400, 'bridge_offline', 'The bridge is not connected. Save a token and enable it.');
    }
    if (!channel.discord_channel_id) {
      throw new HttpError(400, 'channel_not_bridged', 'That channel is not linked to a Discord channel.');
    }

    const cached: WebhookRef | null =
      channel.discord_webhook_id && channel.discord_webhook_token
        ? { id: channel.discord_webhook_id, token: channel.discord_webhook_token }
        : null;

    const result = await transport.mirror({
      discordChannelId: channel.discord_channel_id,
      webhook: cached,
      username,
      content,
    });

    if (!cached) setChannelWebhook(deps.sqlite, channel.id, result.webhook.id, result.webhook.token);
    return result;
  }

  async function mirror(message: Message): Promise<void> {
    if (!transport) return;

    const channel = findChannel(deps.sqlite, message.channelId);
    if (!channel) return;
    if (!channel.discord_channel_id) {
      logger.debug('not mirroring: channel is not bridged', { channelId: message.channelId });
      return;
    }

    const content = message.content.trim();
    if (!content) {
      logger.debug('not mirroring: message has no text', { channelId: message.channelId });
      return;
    }

    const result = await sendToDiscord(
      channel,
      message.author?.displayName ?? message.author?.username ?? 'Harmony',
      content,
    );

    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: message.id,
      discordMessageId: result.messageId,
      createdAt: new Date().toISOString(),
    });
  }

  // Harmony messages are mirrored out; bridged-in messages are not, so they
  // never bounce back to Discord.
  deps.messages.onMessageCreated((message) => {
    void mirror(message).catch((error: unknown) => {
      logger.info('bridge could not mirror a message to Discord', {
        channelId: message.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  return {
    status,

    async applySettings() {
      const bridge = deps.settings.getBridge();
      const desired = bridge.enabled ? bridge.token : null;

      if (desired === activeToken) return;

      if (transport) {
        await transport.stop();
        transport = null;
        activeToken = null;
      }
      if (!desired) return;

      transport = deps.transportFactory(desired, logger);
      transport.onMessage((message) => {
        void ingest(message).catch((error: unknown) => logger.info('bridge ingest failed', error));
      });
      activeToken = desired;
      await transport.start();
    },

    async listDiscordChannels() {
      if (!transport) return { guildName: null, channels: [] };
      return transport.listTextChannels();
    },

    async testMirror(channelId) {
      const channel = findChannel(deps.sqlite, channelId);
      if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');

      await sendToDiscord(channel, 'Harmony', 'Harmony bridge test — this channel is connected.');
    },

    async shutdown() {
      if (!transport) return;
      await transport.stop();
      transport = null;
      activeToken = null;
    },
  };
}
