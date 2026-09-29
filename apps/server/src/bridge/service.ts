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
import { findEmojiByName } from '../db/emojis.ts';
import { findUserByDiscordId, insertGhostUser, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService, ReactionEvent } from '../messages/service.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UserService } from '../users/service.ts';
import { createBlobStore } from '../storage/blobs.ts';
import type {
  BridgeLogger,
  DiscordEmoji,
  DiscordIncomingAttachment,
  DiscordIncomingDelete,
  DiscordIncomingEdit,
  DiscordIncomingMessage,
  DiscordIncomingReaction,
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

  /**
   * Discord webhooks cannot post real replies (Execute Webhook has no
   * message_reference), so a reply is mirrored as a quoted line above the text.
   * Discord renders `> ` as a blockquote, which reads like a reply.
   */
  function outboundContent(message: Message): string {
    const base = message.content.trim();
    const reply = message.replyTo;
    if (!reply) return base;

    const who = reply.author?.displayName ?? reply.author?.username ?? 'someone';
    const snippet = reply.deleted
      ? '(deleted message)'
      : reply.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    const quote = `> **${who}**${snippet ? `: ${snippet}` : ''}`;
    return base ? `${quote}\n${base}` : quote;
  }

  /** Finds the stand-in account for a Discord author, creating it on first sight. */
  function resolveGhostUser(discordId: string, displayName: string): UserRow {
    const existing = findUserByDiscordId(deps.sqlite, discordId);
    if (existing) return existing;

    const id = randomUUID();
    insertGhostUser(deps.sqlite, {
      id,
      // Never shown: the display name carries what users actually see.
      username: `discord_${discordId}`,
      displayName,
      discordId,
      createdAt: new Date().toISOString(),
    });

    const created = findUserByDiscordId(deps.sqlite, discordId);
    if (!created) throw new Error('Failed to create the bridged user');
    return created;
  }

  // The guild's custom emoji, resolved by name so `:name:` can be translated to
  // a real Discord `<:name:id>` tag. Cached until the bridge reconnects.
  let guildEmojiByName: Map<string, DiscordEmoji> | null = null;

  async function discordEmojiMap(): Promise<Map<string, DiscordEmoji>> {
    if (guildEmojiByName) return guildEmojiByName;
    if (!transport) return new Map();
    try {
      guildEmojiByName = new Map((await transport.guildEmojis()).map((emoji) => [emoji.name, emoji]));
    } catch (error) {
      logger.debug('could not list discord emojis', {
        error: error instanceof Error ? error.message : String(error),
      });
      guildEmojiByName = new Map();
    }
    return guildEmojiByName;
  }

  /**
   * Discord's emoji parameter for a reaction: a unicode character is sent as-is,
   * while a `:name:` shortcode becomes `name:id` using the guild's emoji. Returns
   * null when a custom emoji has no counterpart on Discord.
   */
  async function discordReactionParam(emoji: string): Promise<string | null> {
    if (!emoji.startsWith(':')) return emoji;
    const target = (await discordEmojiMap()).get(emoji.slice(1, -1));
    return target ? `${target.name}:${target.id}` : null;
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

    const content = outboundContent(message);
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
      content: outboundContent(message),
    });
  }

  async function mirrorDelete(info: MessageDeletePayload): Promise<void> {
    if (!transport) return;
    const target = mirrorTarget(info.id, info.channelId);
    if (!target) return;

    await transport.deleteMessage({ webhook: target.webhook, discordMessageId: target.discordMessageId });
    deleteBridgeMessage(deps.sqlite, info.id);
  }

  /**
   * Mirrors a reaction change out to Discord. Note that all Harmony reactions to
   * a message come from the single webhook, so Discord shows one reaction per
   * emoji regardless of how many Harmony users reacted.
   */
  async function mirrorReaction(event: ReactionEvent, kind: 'add' | 'remove' | 'clear'): Promise<void> {
    if (!transport) return;
    const target = mirrorTarget(event.message.id, event.message.channelId);
    if (!target) return;

    const emoji = await discordReactionParam(event.emoji);
    if (!emoji) {
      logger.debug('not mirroring a reaction: no matching discord emoji', { emoji: event.emoji });
      return;
    }

    const input = { webhook: target.webhook, discordMessageId: target.discordMessageId, emoji };
    if (kind === 'add') await transport.addReaction(input);
    else if (kind === 'remove') await transport.removeReaction(input);
    else await transport.clearReaction(input);
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

    const author = resolveGhostUser(message.authorId, message.authorName);
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

    // A Discord reply becomes a real Harmony reply when the parent was bridged.
    const replyToId = message.replyToDiscordId
      ? (findBridgeMessageByDiscordId(deps.sqlite, message.replyToDiscordId)?.harmony_message_id ?? null)
      : null;

    const created = deps.messages.createBridged(channel.id, author.id, content, attachmentIds, replyToId);
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

  /** Maps a Discord reaction to the canonical Harmony reaction key. */
  function toHarmonyReaction(reaction: DiscordIncomingReaction): { emoji: string; emojiId: string | null } {
    if (!reaction.emojiId) return { emoji: reaction.emoji, emojiId: null };
    // A custom emoji: reuse the Harmony emoji of the same name so it renders.
    const row = findEmojiByName(deps.sqlite, reaction.emoji);
    return { emoji: `:${reaction.emoji}:`, emojiId: row?.id ?? null };
  }

  async function ingestReaction(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const author = resolveGhostUser(reaction.userId, reaction.userName);
    const { emoji, emojiId } = toHarmonyReaction(reaction);
    deps.messages.addReactionBridged(mapping.harmony_message_id, author.id, emoji, emojiId);
  }

  async function ingestReactionRemoved(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const author = resolveGhostUser(reaction.userId, reaction.userName);
    const { emoji } = toHarmonyReaction(reaction);
    deps.messages.removeReactionBridged(mapping.harmony_message_id, author.id, emoji);
  }

  async function ingestReactionCleared(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const { emoji, emojiId } = toHarmonyReaction(reaction);
    deps.messages.clearReactionsBridged(mapping.harmony_message_id, emoji, emojiId);
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
  deps.messages.onReactionAdded((event) => watch(() => mirrorReaction(event, 'add'), event.message.channelId));
  deps.messages.onReactionRemoved((event) => watch(() => mirrorReaction(event, 'remove'), event.message.channelId));
  deps.messages.onReactionsCleared((event) => watch(() => mirrorReaction(event, 'clear'), event.message.channelId));

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
        guildEmojiByName = null;
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
      transport.onReactionAdded((reaction) => {
        void ingestReaction(reaction).catch((error: unknown) => logger.info('bridge reaction sync failed', error));
      });
      transport.onReactionRemoved((reaction) => {
        void ingestReactionRemoved(reaction).catch((error: unknown) =>
          logger.info('bridge reaction sync failed', error),
        );
      });
      transport.onReactionCleared((reaction) => {
        void ingestReactionCleared(reaction).catch((error: unknown) =>
          logger.info('bridge reaction sync failed', error),
        );
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
