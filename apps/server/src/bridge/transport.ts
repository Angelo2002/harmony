import type { BridgeStatus, DiscordChannelOption } from '@harmony/shared';

export interface DiscordIncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  /** True for any bot, including our own webhook mirrors. Never re-bridged. */
  fromBot: boolean;
}

export interface WebhookRef {
  id: string;
  token: string;
}

export interface MirrorInput {
  discordChannelId: string;
  /** Cached webhook for the channel, if we have already created one. */
  webhook: WebhookRef | null;
  username: string;
  content: string;
}

export interface MirrorResult {
  messageId: string;
  /** The webhook that was used, which may have just been created. */
  webhook: WebhookRef;
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
  mirror(input: MirrorInput): Promise<MirrorResult>;
}
