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
  mirror(input: MirrorInput): Promise<MirrorResult>;
  editMessage(input: EditInput): Promise<void>;
  deleteMessage(input: DeleteInput): Promise<void>;
  /** Fetches an attachment's bytes from the Discord CDN. */
  download(url: string): Promise<Buffer>;
}
