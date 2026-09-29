import type { BridgeStatus, DiscordChannelOption } from '@harmony/shared';

export interface DiscordIncomingAttachment {
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface DiscordIncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  /** Public avatar URL, or null when the author has no custom picture. */
  authorAvatarUrl: string | null;
  /** Discord message this one replies to, or null. */
  replyToDiscordId: string | null;
  content: string;
  attachments: DiscordIncomingAttachment[];
  /** True for any bot, including our own webhook mirrors. Never re-bridged. */
  fromBot: boolean;
}

export interface DiscordIncomingEdit {
  id: string;
  channelId: string;
  content: string;
}

export interface DiscordIncomingDelete {
  id: string;
  channelId: string;
}

export interface WebhookRef {
  id: string;
  token: string;
}

/** A custom emoji that exists in the bridged Discord guild. */
export interface DiscordEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/** A reaction change on a Discord message that we care about. */
export interface DiscordIncomingReaction {
  messageId: string;
  channelId: string;
  userId: string;
  userName: string;
  /** A unicode character, or the custom emoji's name. */
  emoji: string;
  /** The custom emoji id, or null for a unicode emoji. */
  emojiId: string | null;
}

/** Minimal logger the bridge hands down to the transport. */
export interface BridgeLogger {
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export interface MirrorFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MirrorInput {
  discordChannelId: string;
  /** Cached webhook for the channel, if we have already created one. */
  webhook: WebhookRef | null;
  username: string;
  /** Absolute, publicly reachable avatar URL, or null to leave it default. */
  avatarUrl: string | null;
  content: string;
  files: MirrorFile[];
}

export interface MirrorResult {
  messageId: string;
  /** The webhook that was used, which may have just been created. */
  webhook: WebhookRef;
}

export interface EditInput {
  webhook: WebhookRef;
  discordMessageId: string;
  content: string;
}

export interface DeleteInput {
  webhook: WebhookRef;
  discordMessageId: string;
}

export interface ReactionInput {
  /** Discord channel holding the message. Reactions go through the bot, not the webhook. */
  channelId: string;
  discordMessageId: string;
  /**
   * Discord's emoji parameter, ready to drop into the URL: a percent-encoded
   * unicode character, or `name:id` (prefixed with `a:` when animated).
   */
  emoji: string;
}

/**
 * Everything the bridge needs from Discord, behind one small interface. The
 * real implementation wraps discord.js; tests substitute a fake so the
 * orchestration can be verified without a bot token.
 */
export interface DiscordTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): BridgeStatus;
  listTextChannels(): Promise<{ guildName: string | null; channels: DiscordChannelOption[] }>;
  onMessage(handler: (message: DiscordIncomingMessage) => void): void;
  onMessageEdited(handler: (message: DiscordIncomingEdit) => void): void;
  onMessageDeleted(handler: (message: DiscordIncomingDelete) => void): void;
  onReactionAdded(handler: (reaction: DiscordIncomingReaction) => void): void;
  onReactionRemoved(handler: (reaction: DiscordIncomingReaction) => void): void;
  /** Every reaction of one emoji was cleared from a message. */
  onReactionCleared(handler: (reaction: DiscordIncomingReaction) => void): void;
  mirror(input: MirrorInput): Promise<MirrorResult>;
  editMessage(input: EditInput): Promise<void>;
  deleteMessage(input: DeleteInput): Promise<void>;
  /** Custom emoji available in the guild, for translating `:name:` shortcodes. */
  guildEmojis(): Promise<DiscordEmoji[]>;
  addReaction(input: ReactionInput): Promise<void>;
  removeReaction(input: ReactionInput): Promise<void>;
  /** Fetches an attachment's bytes from the Discord CDN. */
  download(url: string): Promise<Buffer>;
}
