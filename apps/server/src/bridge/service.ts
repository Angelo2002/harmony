import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  rewriteMentions,
  type BridgeResponse,
  type DiscordChannelListResponse,
  type ImageContentType,
  type Message,
  type MessageDeletePayload,
  type MessageReference,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { insertAttachment } from '../db/attachments.ts';
import {
  deleteBridgeMessage,
  findBridgeMessageByDiscordId,
  findBridgeMessageByHarmonyId,
  insertBridgeMessage,
} from '../db/bridge.ts';
import { findChannel, findChannelByDiscordId, listChannels, setChannelWebhook, type ChannelRow } from '../db/channels.ts';
import { findEmojiByName } from '../db/emojis.ts';
import { findUserByDiscordId, findUserByUsername, insertGhostUser, type UserRow } from '../db/users.ts';
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
  DiscordMention,
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
  /** Custom emoji in the linked guild, for the emoji import. */
  listGuildEmojis(): Promise<{ guildName: string | null; emojis: DiscordEmoji[] }>;
  /** Downloads one guild emoji's image from the Discord CDN. */
  downloadGuildEmoji(id: string, animated: boolean): Promise<{ data: Buffer; contentType: ImageContentType }>;
  /** Pulls recent Discord history into a bridged channel; returns how many. */
  importChannel(channelId: string, limit?: number): Promise<number>;
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
   * Replaces `:name:` shortcodes with the real `<:name:id>` tags Discord renders,
   * using the guild's emoji of the same name. Unknown shortcodes are left alone.
   */
  async function translateOutboundEmoji(text: string): Promise<string> {
    const map = await discordEmojiMap();
    if (map.size === 0) return text;
    return text.replace(/:([a-zA-Z0-9_]{2,32}):/g, (whole, name: string) => {
      const emoji = map.get(name);
      return emoji ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : whole;
    });
  }

  /**
   * Turns Discord's `<:name:id>` and `<a:name:id>` tags back into `:name:`
   * shortcodes, so a matching Harmony emoji renders and an unknown one at least
   * reads sensibly instead of showing a raw id.
   */
  function translateInboundEmoji(text: string): string {
    return text.replace(/<a?:([a-zA-Z0-9_]{2,32}):\d+>/g, (_whole, name: string) => `:${name}:`);
  }

  /**
   * Rewrites Discord's `<@id>` and `<@!id>` mentions into Harmony `@username`
   * mentions, creating a stand-in account for anyone we have not seen before so
   * the mention always resolves. Unknown ids are left alone.
   */
  function rewriteInboundMentions(content: string, mentions: DiscordMention[]): string {
    if (mentions.length === 0) return content;

    const usernames = new Map<string, string>();
    for (const mention of mentions) {
      usernames.set(mention.id, resolveGhostUser(mention.id, mention.name).username);
    }

    return content.replace(/<@!?(\d+)>/g, (whole, discordId: string) => {
      const username = usernames.get(discordId);
      return username ? `@${username}` : whole;
    });
  }

  /**
   * Discord webhooks cannot post real replies (Execute Webhook has no
   * message_reference), so a reply is mirrored as a quoted line above the text.
   * Discord renders `> ` as a blockquote, which reads like a reply.
   */
  async function outboundContent(
    message: Message,
  ): Promise<{ content: string; allowedUserMentions: string[] }> {
    const { text, discordIds } = rewriteOutboundMentions(message.content.trim());
    const translated = await translateOutboundEmoji(text);
    const reply = message.replyTo;
    const content = reply ? `${quoteFor(reply)}\n${translated}`.trim() : translated;
    return { content, allowedUserMentions: discordIds };
  }

  /**
   * A `@username` that belongs to a bridged stand-in account becomes a real
   * `<@id>` ping; a mention of someone with no Discord account is left as plain
   * text so it still reads sensibly.
   */
  function rewriteOutboundMentions(text: string): { text: string; discordIds: string[] } {
    const discordIds: string[] = [];
    const rewritten = rewriteMentions(text, (username) => {
      const row = findUserByUsername(deps.sqlite, username);
      if (!row?.discord_id) return null;
      if (!discordIds.includes(row.discord_id)) discordIds.push(row.discord_id);
      return `<@${row.discord_id}>`;
    });
    return { text: rewritten, discordIds };
  }

  function quoteFor(reply: MessageReference): string {
    const who = reply.author?.displayName ?? reply.author?.username ?? 'someone';
    const snippet = reply.deleted
      ? '(deleted message)'
      : reply.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `> **${who}**${snippet ? `: ${snippet}` : ''}`;
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
   * Discord's emoji parameter for a reaction: a percent-encoded unicode
   * character, or `name:id` (with an `a:` prefix when animated) using the
   * guild's emoji. Returns null when a custom emoji has no counterpart.
   */
  async function discordReactionParam(emoji: string): Promise<string | null> {
    if (!emoji.startsWith(':')) return encodeURIComponent(emoji);
    const target = (await discordEmojiMap()).get(emoji.slice(1, -1));
    return target ? `${target.animated ? 'a:' : ''}${target.name}:${target.id}` : null;
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
    allowedUserMentions: string[],
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
      allowedUserMentions,
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

    const { content, allowedUserMentions } = await outboundContent(message);
    const files = collectMirrorFiles(message);
    if (!content && files.length === 0) {
      logger.debug('not mirroring: message has no text or files', { channelId: message.channelId });
      return;
    }

    const result = await sendToDiscord(
      channel,
      authorName(message),
      content,
      files,
      avatarUrlFor(message),
      allowedUserMentions,
    );
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

    const { content, allowedUserMentions } = await outboundContent(message);
    await transport.editMessage({
      webhook: target.webhook,
      discordMessageId: target.discordMessageId,
      content,
      allowedUserMentions,
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
   * Where a bridged Harmony message lives on the Discord side, for reactions.
   * Reactions cannot use the webhook (Discord has no such route), so they need
   * the channel id and go through the bot.
   */
  function reactionTarget(
    harmonyMessageId: string,
    channelId: string,
  ): { discordChannelId: string; discordMessageId: string } | null {
    const mapping = findBridgeMessageByHarmonyId(deps.sqlite, harmonyMessageId);
    if (!mapping) return null;

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel?.discord_channel_id) return null;

    return { discordChannelId: channel.discord_channel_id, discordMessageId: mapping.discord_message_id };
  }

  /**
   * Mirrors a reaction change out to Discord. Reactions are placed by the bot,
   * because Discord has no webhook reaction route. Since the bot can only hold
   * one reaction per emoji, it represents the whole Harmony tally: it is added
   * when the first person reacts and removed only once the last one does.
   */
  async function mirrorReaction(event: ReactionEvent, kind: 'add' | 'remove' | 'clear'): Promise<void> {
    if (!transport) return;
    const target = reactionTarget(event.message.id, event.message.channelId);
    if (!target) return;

    // For a removal, keep the bot's reaction while others remain in Harmony.
    if (kind !== 'add' && event.message.reactions.some((reaction) => reaction.emoji === event.emoji)) return;

    const emoji = await discordReactionParam(event.emoji);
    if (!emoji) {
      logger.debug('not mirroring a reaction: no matching discord emoji', { emoji: event.emoji });
      return;
    }

    const input = { channelId: target.discordChannelId, discordMessageId: target.discordMessageId, emoji };
    if (kind === 'add') await transport.addReaction(input);
    else await transport.removeReaction(input);
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

  async function ingest(message: DiscordIncomingMessage): Promise<boolean> {
    const active = transport;
    // Ignore bots, including our own mirrored webhook messages.
    if (!active || message.fromBot) return false;
    // Already bridged: a live event and a history import can race here.
    if (findBridgeMessageByDiscordId(deps.sqlite, message.id)) return false;

    const channel = findChannelByDiscordId(deps.sqlite, message.channelId);
    if (!channel) return false;

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
    const content = [
      rewriteInboundMentions(translateInboundEmoji(message.content), message.mentions),
      ...skipped,
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n');
    if (!content && attachmentIds.length === 0) return false;

    // A Discord reply becomes a real Harmony reply when the parent was bridged.
    const replyToId = message.replyToDiscordId
      ? (findBridgeMessageByDiscordId(deps.sqlite, message.replyToDiscordId)?.harmony_message_id ?? null)
      : null;

    const created = deps.messages.createBridged(
      channel.id,
      author.id,
      content,
      attachmentIds,
      replyToId,
      message.createdAt,
    );
    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: created.id,
      discordMessageId: message.id,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  /** How many recent Discord messages a plain backfill pulls in. */
  const HISTORY_IMPORT_LIMIT = 50;

  /**
   * Pulls recent Discord history into a bridged channel. Messages already known
   * are skipped by their Discord id, so this is safe to run on every link, on
   * startup and on demand.
   */
  async function importChannel(channelId: string, requestedLimit?: number): Promise<number> {
    const active = transport;
    if (!active) {
      throw new HttpError(400, 'bridge_offline', 'The bridge is not connected. Save a token and enable it.');
    }

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    if (!channel.discord_channel_id) {
      throw new HttpError(400, 'channel_not_bridged', 'That channel is not linked to a Discord channel.');
    }

    const limit = Math.min(Math.max(requestedLimit ?? HISTORY_IMPORT_LIMIT, 1), 100);
    const messages = await active.fetchRecentMessages(channel.discord_channel_id, limit);

    let imported = 0;
    for (const message of messages) {
      if (await ingest(message)) imported++;
    }
    if (imported > 0) logger.info('imported discord history', { channelId, imported });
    return imported;
  }

  /** Backfills every bridged channel, best effort, without blocking startup. */
  async function importAllBridged(): Promise<void> {
    for (const channel of listChannels(deps.sqlite)) {
      if (!channel.discord_channel_id) continue;
      try {
        await importChannel(channel.id);
      } catch (error) {
        logger.debug('could not import discord history', {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function ingestEdit(edit: DiscordIncomingEdit): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, edit.id);
    if (!mapping) return;
    deps.messages.editBridged(mapping.harmony_message_id, translateInboundEmoji(edit.content));
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
      logger.info('bridge could not sync a change to Discord', {
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
      // Backfill any history we have not seen yet, without blocking startup.
      void importAllBridged();
    },

    async listDiscordChannels() {
      if (!transport) return { guildName: null, channels: [] };
      return transport.listTextChannels();
    },

    async listGuildEmojis() {
      if (!transport) return { guildName: null, emojis: [] };
      return { guildName: transport.status().guildName, emojis: await transport.guildEmojis() };
    },

    async downloadGuildEmoji(id, animated) {
      if (!transport) throw new HttpError(503, 'bridge_offline', 'The Discord bridge is not connected.');
      // Discord serves animated emoji as GIF and everything else as PNG.
      const ext = animated ? 'gif' : 'png';
      const data = await transport.download(`https://cdn.discordapp.com/emojis/${id}.${ext}`);
      return { data, contentType: animated ? 'image/gif' : 'image/png' };
    },

    importChannel,

    async testMirror(channelId) {
      const channel = findChannel(deps.sqlite, channelId);
      if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');

      await sendToDiscord(channel, 'Harmony', 'Harmony bridge test — this channel is connected.', [], null, []);
    },

    async shutdown() {
      if (!transport) return;
      await transport.stop();
      transport = null;
      activeToken = null;
    },
  };
}
