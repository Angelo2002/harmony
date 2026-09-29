import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  type BridgeResponse,
  type DiscordChannelListResponse,
  type ImageContentType,
  type Message,
  type MessageDeletePayload,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { insertAttachment } from '../db/attachments.ts';
import {
  deleteBridgeMessage,
  findBridgeMessageByDiscordId,
  findBridgeMessageByHarmonyId,
  insertBridgeMessage,
} from '../db/bridge.ts';
import { findChannel, findChannelByDiscordId, setChannelWebhook, type ChannelRow } from '../db/channels.ts';
import { findUserByDiscordId, insertGhostUser, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UserService } from '../users/service.ts';
import { createBlobStore } from '../storage/blobs.ts';
import type {
  BridgeLogger,
  DiscordIncomingAttachment,
  DiscordIncomingDelete,
  DiscordIncomingEdit,
  DiscordIncomingMessage,
  DiscordTransport,
  MirrorFile,
  MirrorResult,
  WebhookRef,
} from './transport.ts';

/** Discord's default upload ceiling for a non-boosted server. */
const DISCORD_MAX_FILE_BYTES = 8 * 1024 * 1024;

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
  config: Config;
  settings: SettingsService;
  messages: MessageService;
  users: UserService;
  logger: BridgeLogger;
  transportFactory: (token: string, logger: BridgeLogger) => DiscordTransport;
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const { logger } = deps;
  const blobs = createBlobStore(deps.config);
  let transport: DiscordTransport | null = null;
  let activeToken: string | null = null;

  function status(): BridgeResponse {
    const config = deps.settings.getBridgePublic();
    return {
      configured: config.configured,
      enabled: config.enabled,
      publicBaseUrl: config.publicBaseUrl,
      status: transport?.status() ?? { ready: false, botTag: null, guildName: null, error: null },
    };
  }

  function webhookFor(channel: ChannelRow): WebhookRef | null {
    return channel.discord_webhook_id && channel.discord_webhook_token
      ? { id: channel.discord_webhook_id, token: channel.discord_webhook_token }
      : null;
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Harmony';
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

  // ---- Outbound: Harmony -> Discord ----

  /**
   * Absolute avatar URL that Discord can fetch, or null when we do not know our
   * own public address or the author has no picture. The hash doubles as the
   * capability that lets Discord in without a session.
   */
  function avatarUrlFor(message: Message): string | null {
    const base = deps.settings.getBridge().publicBaseUrl;
    const user = message.author;
    if (!base || !user?.avatarHash) return null;
    return `${base.replace(/\/+$/, '')}/api/v1/users/${user.id}/avatar?v=${user.avatarHash}`;
  }

  /** Shared by normal mirroring and the admin's test message. */
  async function sendToDiscord(
    channel: ChannelRow,
    username: string,
    content: string,
    files: MirrorFile[],
    avatarUrl: string | null,
  ): Promise<MirrorResult> {
    if (!transport) {
      throw new HttpError(400, 'bridge_offline', 'The bridge is not connected. Save a token and enable it.');
    }
    if (!channel.discord_channel_id) {
      throw new HttpError(400, 'channel_not_bridged', 'That channel is not linked to a Discord channel.');
    }

    const result = await transport.mirror({
      discordChannelId: channel.discord_channel_id,
      webhook: webhookFor(channel),
      username,
      avatarUrl,
      content,
      files,
    });

    setChannelWebhook(deps.sqlite, channel.id, result.webhook.id, result.webhook.token);
    return result;
  }

  function collectMirrorFiles(message: Message): MirrorFile[] {
    const files: MirrorFile[] = [];
    for (const attachment of message.attachments) {
      if (attachment.size > DISCORD_MAX_FILE_BYTES) {
        logger.debug('skipping an attachment too large for discord', {
          filename: attachment.filename,
          size: attachment.size,
        });
        continue;
      }
      try {
        files.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          data: readFileSync(blobs.pathFor(attachment.hash)),
        });
      } catch (error) {
        logger.debug('could not read an attachment blob', {
          filename: attachment.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return files;
  }

  async function mirror(message: Message): Promise<void> {
    if (!transport) return;

    const channel = findChannel(deps.sqlite, message.channelId);
    if (!channel?.discord_channel_id) {
      logger.debug('not mirroring: channel is not bridged', { channelId: message.channelId });
      return;
    }

    const content = message.content.trim();
    const files = collectMirrorFiles(message);
    if (!content && files.length === 0) {
      logger.debug('not mirroring: message has no text or files', { channelId: message.channelId });
      return;
    }

    const result = await sendToDiscord(channel, authorName(message), content, files, avatarUrlFor(message));
    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: message.id,
      discordMessageId: result.messageId,
      createdAt: new Date().toISOString(),
    });
  }

  /** Where a bridged Harmony message lives on the Discord side, if anywhere. */
  function mirrorTarget(harmonyMessageId: string, channelId: string) {
    const mapping = findBridgeMessageByHarmonyId(deps.sqlite, harmonyMessageId);
    if (!mapping) return null;

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel) return null;

    const webhook = webhookFor(channel);
    if (!webhook) return null;

    return { webhook, discordMessageId: mapping.discord_message_id };
  }

  async function mirrorEdit(message: Message): Promise<void> {
    if (!transport) return;
    const target = mirrorTarget(message.id, message.channelId);
    if (!target) return;

    await transport.editMessage({
      webhook: target.webhook,
      discordMessageId: target.discordMessageId,
      content: message.content,
    });
  }

  async function mirrorDelete(info: MessageDeletePayload): Promise<void> {
    if (!transport) return;
    const target = mirrorTarget(info.id, info.channelId);
    if (!target) return;

    await transport.deleteMessage({ webhook: target.webhook, discordMessageId: target.discordMessageId });
    deleteBridgeMessage(deps.sqlite, info.id);
  }

  // ---- Inbound: Discord -> Harmony ----

  async function storeInboundAttachment(
    active: DiscordTransport,
    author: UserRow,
    attachment: DiscordIncomingAttachment,
  ): Promise<string | null> {
    if (!ALLOWED_IMAGE_TYPES.includes(attachment.contentType as ImageContentType)) return null;
    if (attachment.size > deps.config.maxUploadBytes) return null;

    try {
      const data = await active.download(attachment.url);
      if (data.length > deps.config.maxUploadBytes) return null;

      let metadata: Metadata;
      try {
        metadata = await sharp(data).metadata();
      } catch {
        return null; // Not a real image.
      }

      const id = randomUUID();
      insertAttachment(deps.sqlite, {
        id,
        uploaderId: author.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: data.length,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        hash: blobs.save(data),
        createdAt: new Date().toISOString(),
      });
      return id;
    } catch (error) {
      logger.debug('could not mirror a discord attachment', {
        url: attachment.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Imports a Discord author's picture the first time we see one, so bridged
   * users show their real avatar. Skipped once they have one, to avoid
   * re-downloading on every message.
   */
  async function mirrorGhostAvatar(
    active: DiscordTransport,
    author: UserRow,
    message: DiscordIncomingMessage,
  ): Promise<void> {
    if (author.avatar_hash || !message.authorAvatarUrl) return;
    try {
      const data = await active.download(message.authorAvatarUrl);
      await deps.users.setAvatarFromData(author.id, data);
    } catch (error) {
      logger.debug('could not mirror a discord avatar', {
        authorId: message.authorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ingest(message: DiscordIncomingMessage): Promise<void> {
    const active = transport;
    // Ignore bots, including our own mirrored webhook messages.
    if (!active || message.fromBot) return;

    const channel = findChannelByDiscordId(deps.sqlite, message.channelId);
    if (!channel) return;

    const author = resolveGhostUser(message);
    await mirrorGhostAvatar(active, author, message);

    const attachmentIds: string[] = [];
    const skipped: string[] = [];
    for (const attachment of message.attachments) {
      const stored = await storeInboundAttachment(active, author, attachment);
      if (stored) attachmentIds.push(stored);
      else skipped.push(attachment.url);
    }

    // Anything we cannot mirror is preserved as a link rather than dropped.
    const content = [message.content, ...skipped].filter((part) => part.trim().length > 0).join('\n');
    if (!content && attachmentIds.length === 0) return;

    const created = deps.messages.createBridged(channel.id, author.id, content, attachmentIds);
    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: created.id,
      discordMessageId: message.id,
      createdAt: new Date().toISOString(),
    });
  }

  async function ingestEdit(edit: DiscordIncomingEdit): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, edit.id);
    if (!mapping) return;
    deps.messages.editBridged(mapping.harmony_message_id, edit.content);
  }

  async function ingestDelete(deletion: DiscordIncomingDelete): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, deletion.id);
    if (!mapping) return;

    deps.messages.deleteBridged(mapping.harmony_message_id);
    deleteBridgeMessage(deps.sqlite, mapping.harmony_message_id);
  }

  // Messages created or changed in Harmony are mirrored out; bridged-in changes
  // are applied through the *Bridged methods, which never notify, so nothing
  // ever bounces back to Discord.
  function watch(action: () => Promise<void>, channelId: string | undefined): void {
    void action().catch((error: unknown) => {
      logger.info('bridge could not sync a message to Discord', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  deps.messages.onMessageCreated((message) => watch(() => mirror(message), message.channelId));
  deps.messages.onMessageEdited((message) => watch(() => mirrorEdit(message), message.channelId));
  deps.messages.onMessageDeleted((info) => watch(() => mirrorDelete(info), info.channelId));

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
      transport.onMessageEdited((edit) => {
        void ingestEdit(edit).catch((error: unknown) => logger.info('bridge edit sync failed', error));
      });
      transport.onMessageDeleted((deletion) => {
        void ingestDelete(deletion).catch((error: unknown) => logger.info('bridge delete sync failed', error));
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

      await sendToDiscord(channel, 'Harmony', 'Harmony bridge test — this channel is connected.', [], null);
    },

    async shutdown() {
      if (!transport) return;
      await transport.stop();
      transport = null;
      activeToken = null;
    },
  };
}
