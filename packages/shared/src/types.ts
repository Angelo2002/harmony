export type SnowflakeId = string;
export type IsoTimestamp = string;
export type ChannelType = 'text';

export interface User {
  id: SnowflakeId;
  username: string;
  displayName: string | null;
  avatarHash: string | null;
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
