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
  /** End of an active moderation timeout, or null when not timed out. */
  timedOutUntil: IsoTimestamp | null;
  /**
   * Whether typing indicators are on for this user. When false they neither
   * broadcast their own typing nor see anyone else's.
   */
  showTyping: boolean;
  /**
   * The Discord account this stand-in represents, or null for a real member.
   * Only ever set on accounts the bridge created for the other side of a link.
   */
  discordId: string | null;
}

/** A ban, with the user it applies to and who issued it. */
export interface Ban {
  user: User;
  bannedBy: User | null;
  reason: string | null;
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
  /**
   * A role required to see this category and every channel in it, or null when
   * it is open to everyone. Categories are never more open than their role.
   */
  requiredRoleId: SnowflakeId | null;
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
  /**
   * A role required to see this channel, or null to inherit from its category
   * and ultimately to be open to everyone.
   */
  requiredRoleId: SnowflakeId | null;
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

/**
 * A basic link preview unfurled from a message's first embeddable URL. Only text
 * is kept: no remote images are fetched or stored.
 */
export interface LinkEmbed {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /**
   * A preview image the page advertises, or the link itself when it points
   * straight at an image. Clients load it through `GET /api/v1/embeds/media`
   * rather than from the remote host.
   */
  imageUrl: string | null;
  /** An inline player to offer, when the link is one we can play ourselves. */
  player: EmbedPlayer | null;
}

/**
 * A playable embed. The id is all that crosses the wire: a client builds the
 * player URL from a provider it knows, so the origin is never taken from the
 * page we scraped.
 */
export interface EmbedPlayer {
  provider: 'youtube';
  id: string;
}

/** What an audit entry records. */
export type AuditKind =
  | 'message_delete'
  | 'message_edit'
  | 'media_delete'
  | 'timeout_add'
  | 'timeout_clear'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'role_add'
  | 'role_remove';

/**
 * The kind-specific fields of an audit entry. Every field is optional because
 * each kind fills in only the ones it needs:
 *
 * - `message_delete` / `message_edit`: `channelName` and `before`, plus `after`
 *   for an edit, and `attachments` for a deletion that carried images.
 * - `media_delete`: `filename` and `channelName`.
 * - `timeout_add`: `durationMinutes`. `ban`: `reason`.
 * - `role_add` / `role_remove`: `roleName`.
 *
 * `actorName` and `targetName` are snapshots taken when the entry was written,
 * so it stays readable after a rename or a deletion.
 */
export interface AuditDetail {
  channelName?: string;
  roleName?: string;
  filename?: string;
  actorName?: string;
  targetName?: string;
  before?: string;
  after?: string;
  durationMinutes?: number;
  reason?: string | null;
  /** Images that went with a deleted message, so the log can still show them. */
  attachments?: Array<{ id: SnowflakeId; filename: string }>;
}

/** One recorded admin or moderation action. */
export interface AuditEntry {
  id: SnowflakeId;
  kind: AuditKind;
  /** Who performed it, or null once that account is gone. */
  actor: User | null;
  /** Who it happened to, when the kind has a target. */
  target: User | null;
  createdAt: IsoTimestamp;
  detail: AuditDetail;
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
  /** Distinct emoji reactions, aggregated. Empty when there are none. */
  reactions: Reaction[];
  /** A preview of the first embeddable link in `content`, or null. */
  embed: LinkEmbed | null;
}

/**
 * One emoji's worth of reactions on a message. Individual reactors are not
 * exposed; the client only needs the tally and whether it is one of them.
 */
export interface Reaction {
  /** A unicode character, or `:name:` for a custom Harmony emoji. */
  emoji: string;
  /** The custom emoji id when `emoji` is a `:name:` shortcode, else null. */
  emojiId: SnowflakeId | null;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
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
