import type { Category, Channel, Emoji, Invite, Message, Role, User } from './types.ts';

/** Response for a successful register or login. */
export interface AuthResponse {
  user: User;
  /** Raw session token, for API clients that authenticate via `Authorization: Bearer`. */
  token: string;
}

/** Response for `GET /api/v1/auth/me`. */
export interface MeResponse {
  user: User;
  /** Effective permissions as a decimal bitfield string. */
  permissions: string;
}

/** Consistent error body returned by every API endpoint. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Response for `GET /api/v1/channels`. */
export interface ChannelListResponse {
  categories: Category[];
  channels: Channel[];
}

/** Response for `GET /api/v1/channels/:id/messages`. */
export interface MessageListResponse {
  messages: Message[];
}

/** Public instance metadata, used by clients before they sign in. */
export interface InstanceMeta {
  name: string;
  apiVersion: string;
  requireInvite: boolean;
  maxUploadBytes: number;
  allowedImageTypes: readonly string[];
  limits: {
    messageLength: number;
    attachmentsPerMessage: number;
    channelNameMax: number;
    usernameMin: number;
    usernameMax: number;
    passwordMin: number;
  };
}

/** Response for `GET` / `PATCH /api/v1/settings`. */
export interface ServerSettingsResponse {
  serverName: string;
  requireInvite: boolean;
}

/** A user together with the roles assigned to them. */
export interface MemberSummary {
  user: User;
  roleIds: string[];
  /** Effective permissions as a decimal bitfield string. */
  permissions: string;
}

export interface MemberListResponse {
  members: MemberSummary[];
}

export interface RoleListResponse {
  roles: Role[];
}

export interface InviteListResponse {
  invites: Invite[];
}

export interface EmojiListResponse {
  emojis: Emoji[];
}

/** When content is automatically deleted. `null` means "keep forever". */
export interface RetentionSettings {
  /** Delete image attachments older than this many days. */
  imageRetentionDays: number | null;
  /** Delete messages older than this many days. */
  messageRetentionDays: number | null;
  /** Start emergency pruning once stored media exceeds this many bytes. */
  storageLimitBytes: number | null;
  /** Emergency pruning deletes oldest content until usage is back under this. */
  storageTargetBytes: number | null;
}

export interface RetentionUsage {
  /** Bytes of stored media (attachments and emoji). */
  blobBytes: number;
  attachmentCount: number;
  messageCount: number;
}

export interface PruneSummary {
  ranAt: string;
  deletedAttachments: number;
  deletedMessages: number;
  deletedBlobs: number;
  freedBytes: number;
}

export interface RetentionResponse {
  settings: RetentionSettings;
  usage: RetentionUsage;
  lastRun: PruneSummary | null;
}

export interface RetentionRunResponse {
  summary: PruneSummary;
  usage: RetentionUsage;
}
