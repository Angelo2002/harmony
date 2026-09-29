import type { Attachment, AuditEntry, Ban, Category, Channel, Emoji, Invite, Message, Role, User } from './types.ts';
import type { ThemeSettings } from './theme.ts';

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
  /** Channel a client should open on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
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
  /** Instance colours, so even the sign-in screen is themed. */
  theme: ThemeSettings;
  /**
   * Content hash of the admin-uploaded server icon, or null to use the client's
   * built-in default. Clients fetch the icon at `GET /api/v1/icon`.
   */
  iconHash: string | null;
  /** Largest accepted image upload, in bytes. */
  maxImageBytes: number;
  /** Largest accepted video upload, in bytes. */
  maxVideoBytes: number;
  allowedImageTypes: readonly string[];
  allowedVideoTypes: readonly string[];
  limits: {
    messageLength: number;
    attachmentsPerMessage: number;
    channelNameMax: number;
    usernameMin: number;
    usernameMax: number;
    passwordMin: number;
  };
}

/** Response for `PUT` / `DELETE /api/v1/icon`. */
export interface InstanceIconResponse {
  /** Content hash of the stored icon, or null when it has been reset. */
  iconHash: string | null;
}

/** Response for `GET` / `PATCH /api/v1/settings`. */
export interface ServerSettingsResponse {
  serverName: string;
  requireInvite: boolean;
  /** Channel opened by default on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: boolean;
  /** Instance colours; everything else in the palette is derived from these. */
  theme: ThemeSettings;
  /** Largest accepted image upload, in bytes. */
  maxImageBytes: number;
  /** Largest accepted video upload, in bytes. */
  maxVideoBytes: number;
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

/**
 * The public member directory: every user's profile, with no roles or
 * permissions. Used to resolve `@username` mentions and to autocomplete them.
 */
export interface UserDirectoryResponse {
  users: User[];
}

/**
 * One member of the public roster. Unlike the management view this carries no
 * permissions, but it does carry role ids so clients can group members the way
 * the server's hoisted roles describe, plus a live online flag.
 */
export interface MemberRosterEntry {
  user: User;
  roleIds: string[];
  online: boolean;
}

export interface MemberRosterResponse {
  members: MemberRosterEntry[];
}

/** Banned users, for `GET /api/v1/bans`. */
export interface BanListResponse {
  bans: Ban[];
}

/** A page of the audit log, newest first. */
export interface AuditListResponse {
  entries: AuditEntry[];
}

/** One stored image, resolved for the admin media gallery. */
export interface MediaItem {
  attachment: Attachment;
  uploader: User | null;
  /** Channel holding the attachment's message, or null for an abandoned upload. */
  channelId: string | null;
  channelName: string | null;
}

/** A page of the media gallery, newest first. */
export interface MediaListResponse {
  media: MediaItem[];
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

/** A custom emoji that exists in the linked Discord server. */
export interface DiscordEmojiOption {
  id: string;
  name: string;
  animated: boolean;
  /** True when Harmony already has an emoji of this name. */
  imported: boolean;
}

export interface DiscordEmojiListResponse {
  /** The guild the bot is connected to, or null when the bridge is not running. */
  guildName: string | null;
  emojis: DiscordEmojiOption[];
}

/** How many Discord emoji an import created, skipped and could not read. */
export interface EmojiImportResponse {
  imported: number;
  /** Already present in Harmony. */
  skipped: number;
  /** Could not be downloaded or stored, e.g. a bad name or an oversized file. */
  failed: number;
}

/** When content is automatically deleted. `null` means "keep forever". */
export interface RetentionSettings {
  /** Delete image attachments older than this many days. */
  imageRetentionDays: number | null;
  /** Delete video attachments older than this many days. */
  videoRetentionDays: number | null;
  /** Delete messages older than this many days. */
  messageRetentionDays: number | null;
  /** Delete audit log entries older than this many days. */
  auditRetentionDays: number | null;
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
  deletedAuditEntries: number;
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

/** State of the Discord bot connection. */
export interface BridgeStatus {
  ready: boolean;
  /** The bot's own tag, e.g. `harmony#1234`. */
  botTag: string | null;
  guildName: string | null;
  error: string | null;
}

export interface BridgeResponse {
  /** Whether a token has been saved. The token itself is never returned. */
  configured: boolean;
  enabled: boolean;
  /** Public base URL, or null when outbound avatars are disabled. */
  publicBaseUrl: string | null;
  status: BridgeStatus;
}

export interface DiscordChannelOption {
  id: string;
  name: string;
  /** The Discord category this channel sits in, or null at the top level. */
  categoryId: string | null;
}

export interface DiscordCategoryOption {
  id: string;
  name: string;
}

export interface DiscordChannelListResponse {
  guildName: string | null;
  /** Discord categories in display order, for the channel import. */
  categories: DiscordCategoryOption[];
  channels: DiscordChannelOption[];
}

/** One Discord channel offered to the channel import. */
export interface DiscordChannelImportOption {
  id: string;
  name: string;
  /** True when a Harmony channel already syncs with it. */
  bridged: boolean;
}

/** The Discord channels that share a category, as the import preview groups them. */
export interface DiscordChannelImportGroup {
  /** The Discord category's name, or null for uncategorised channels. */
  categoryName: string | null;
  channels: DiscordChannelImportOption[];
}

export interface DiscordChannelImportPreview {
  /** The guild the bot is connected to, or null when the bridge is not running. */
  guildName: string | null;
  groups: DiscordChannelImportGroup[];
}

/** How a Discord channel import went. */
export interface ChannelImportResponse {
  /** Channels created and bridged. */
  imported: number;
  /** Discord channels already bridged in Harmony. */
  skipped: number;
  /** Channels whose name does not fit Harmony's rules. */
  failed: number;
  /** New Harmony categories made to hold the imports. */
  categoriesCreated: number;
}

/** How many Discord messages a history import pulled in. */
export interface BridgeImportResponse {
  imported: number;
}
