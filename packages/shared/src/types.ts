export type SnowflakeId = string;
export type IsoTimestamp = string;
export type ChannelType = 'text';

export interface User {
  id: SnowflakeId;
  username: string;
  displayName: string | null;
  avatarHash: string | null;
  /**
   * Colour of the user's highest-positioned coloured role, or null for the
   * default text colour. Purely a display concern — it has no bearing on
   * permissions.
   */
  roleColor: number | null;
  isBot: boolean;
  isOwner: boolean;
  createdAt: IsoTimestamp;
}

export interface Role {
  id: SnowflakeId;
  name: string;
  /** Packed RGB integer, or null for the neutral default colour. */
  color: number | null;
  position: number;
  /** Permission bitfield as a decimal string (JSON cannot carry a bigint). */
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  isDefault: boolean;
}

export interface Category {
  id: SnowflakeId;
  name: string;
  position: number;
}

export interface Channel {
  id: SnowflakeId;
  name: string;
  topic: string | null;
  type: ChannelType;
  categoryId: SnowflakeId | null;
  position: number;
  createdAt: IsoTimestamp;
  /** Discord channel this one is bridged with, or null when not bridged. */
  discordChannelId: string | null;
}

export interface Attachment {
  id: SnowflakeId;
  messageId: SnowflakeId | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  createdAt: IsoTimestamp;
}

export interface Message {
  id: SnowflakeId;
  channelId: SnowflakeId;
  author: User | null;
  content: string;
  createdAt: IsoTimestamp;
  editedAt: IsoTimestamp | null;
  attachments: Attachment[];
  /** The message this one replies to, or null for a normal message. */
  replyTo: MessageReference | null;
}

/**
 * A compact view of the parent of a reply, enough to render the inline preview
 * without shipping the whole message (and its attachments) again.
 */
export interface MessageReference {
  id: SnowflakeId;
  author: User | null;
  /** The original text, or an empty string when it has been deleted. */
  content: string;
  deleted: boolean;
}

export interface Emoji {
  id: SnowflakeId;
  name: string;
  hash: string;
  animated: boolean;
}

export interface Invite {
  code: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp | null;
  maxUses: number | null;
  uses: number;
}
