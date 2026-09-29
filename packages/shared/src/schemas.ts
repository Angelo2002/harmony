import { z } from 'zod';
import { LIMITS, MAX_UPLOAD_CEILING_BYTES } from './constants.ts';
import { TIMEOUT_MAX_MINUTES } from './moderation.ts';
import { HEX_COLOR_PATTERN } from './theme.ts';

export const usernameSchema = z
  .string()
  .min(LIMITS.username.min)
  .max(LIMITS.username.max)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dot, dash and underscore are allowed');

export const passwordSchema = z.string().min(LIMITS.password.min).max(LIMITS.password.max);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  /** Only required when the instance has `HARMONY_REQUIRE_INVITE=true`. */
  inviteCode: z.string().min(1).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: usernameSchema,
  // Login only checks that a password was supplied; registration enforces the policy.
  password: z.string().min(1).max(LIMITS.password.max),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createChannelSchema = z.object({
  name: z.string().min(LIMITS.channelName.min).max(LIMITS.channelName.max),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  discordChannelId: z.string().nullable().optional(),
  /** A role required to see the channel, or null for open access. */
  requiredRoleId: z.string().nullable().optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const createMessageSchema = z
  .object({
    content: z.string().max(LIMITS.messageLength).default(''),
    attachmentIds: z.array(z.string()).max(LIMITS.attachmentsPerMessage).optional(),
    /** Id of the message being replied to, if any. */
    replyToId: z.string().nullable().optional(),
  })
  .refine((value) => value.content.trim().length > 0 || (value.attachmentIds?.length ?? 0) > 0, {
    message: 'A message needs text or at least one attachment.',
    path: ['content'],
  });
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createInviteSchema = z.object({
  /** `null`/absent means unlimited uses. */
  maxUses: z.number().int().positive().nullable().optional(),
  /** `null`/absent means the code never expires. */
  expiresInHours: z.number().positive().nullable().optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const createCategorySchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max),
  /** A role required to see the category and its channels, or null for open. */
  requiredRoleId: z.string().nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  position: z.number().int().optional(),
  /** A role required to see the category and its channels, or null for open. */
  requiredRoleId: z.string().nullable().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  discordChannelId: z.string().nullable().optional(),
  /** A role required to see the channel, or null to inherit or open it up. */
  requiredRoleId: z.string().nullable().optional(),
});
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const editMessageSchema = z.object({
  content: z.string().min(1).max(LIMITS.messageLength),
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

/**
 * A reaction target. `emoji` is a unicode character, or `:name:` paired with
 * `emojiId` for a custom emoji.
 */
export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(64),
  emojiId: z.string().nullable().optional(),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

/** Same fields, but for a query string (used by the clear-all endpoint). */
export const reactionQuerySchema = z.object({
  emoji: z.string().trim().min(1).max(64),
  emojiId: z.string().optional(),
});
export type ReactionQuery = z.infer<typeof reactionQuerySchema>;

/**
 * Cursor pagination, shared by message history and the media gallery: a page
 * size, plus the timestamp and id of the oldest item already held. The id matters
 * because a timestamp alone can tie.
 */
const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Return items created strictly before this ISO timestamp. */
  before: z.string().optional(),
  /** Id of the item `before` came from, to break ties within a millisecond. */
  beforeId: z.string().optional(),
});

export const messageHistoryQuerySchema = cursorQuerySchema;
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

/** The audit log pages the same way, newest first. */
export const auditQuerySchema = cursorQuerySchema;
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const mediaQuerySchema = cursorQuerySchema;
export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/** Permission bitfields cross the wire as decimal strings. */
const permissionString = z.string().regex(/^\d+$/, 'Must be a decimal permission bitfield');

export const createRoleSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max),
  color: z.number().int().min(0).max(0xffffff).nullable().optional(),
  permissions: permissionString.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  color: z.number().int().min(0).max(0xffffff).nullable().optional(),
  permissions: permissionString.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** A per-type upload limit in bytes: at least 1 KiB, at most the hard ceiling. */
const uploadSize = z.number().int().min(1024).max(MAX_UPLOAD_CEILING_BYTES).optional();

export const updateSettingsSchema = z.object({
  serverName: z.string().min(1).max(64).optional(),
  requireInvite: z.boolean().optional(),
  /** The channel opened by default on load. Null clears the preference. */
  defaultChannelId: z.string().nullable().optional(),
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: z.boolean().optional(),
  /** Instance colours. Every other colour in the palette is derived from these. */
  theme: z
    .object({
      background: z.string().regex(HEX_COLOR_PATTERN, 'Must be a #rrggbb colour').nullable(),
      accent: z.string().regex(HEX_COLOR_PATTERN, 'Must be a #rrggbb colour').nullable(),
    })
    .partial()
    .optional(),
  /** Upload size limits, in bytes; the ceiling is what the server can buffer. */
  maxImageBytes: uploadSize,
  maxVideoBytes: uploadSize,
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/** A one-step reorder, shared by roles, channels and categories. */
export const moveSchema = z.object({
  direction: z.enum(['up', 'down']),
});
export type MoveInput = z.infer<typeof moveSchema>;

/** Emoji shortcodes are written as `:name:` and use Discord's name rules. */
export const emojiNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{2,32}$/, 'Emoji names use 2-32 letters, numbers or underscores');

export const createEmojiSchema = z.object({
  name: emojiNameSchema,
});
export type CreateEmojiInput = z.infer<typeof createEmojiSchema>;

/** `null` disables the rule; omitted fields are left unchanged. */
const retentionNumber = z.number().int().min(0).nullable().optional();

export const updateRetentionSchema = z.object({
  imageRetentionDays: retentionNumber,
  videoRetentionDays: retentionNumber,
  messageRetentionDays: retentionNumber,
  auditRetentionDays: retentionNumber,
  storageLimitBytes: retentionNumber,
  storageTargetBytes: retentionNumber,
});
export type UpdateRetentionInput = z.infer<typeof updateRetentionSchema>;

export const updateBridgeSchema = z
  .object({
    /** Omit to leave unchanged; an empty string clears the saved token. */
    token: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
    /** Public base URL used to hand avatar URLs to Discord; null disables them. */
    publicBaseUrl: z.string().trim().max(500).nullable().optional(),
  })
  // A malformed address would make Discord reject webhook posts outright, so it
  // is caught here rather than silently breaking every mirrored message.
  .refine(
    (value) =>
      value.publicBaseUrl == null || value.publicBaseUrl === '' || /^https?:\/\/\S+$/.test(value.publicBaseUrl),
    {
      message: 'Use a full http(s) address, like https://chat.example.com',
      path: ['publicBaseUrl'],
    },
  );
export type UpdateBridgeInput = z.infer<typeof updateBridgeSchema>;

export const bridgeTestSchema = z.object({
  channelId: z.string().min(1),
});
export type BridgeTestInput = z.infer<typeof bridgeTestSchema>;

/** Pull recent Discord history into a bridged channel. */
export const bridgeImportSchema = z.object({
  channelId: z.string().min(1),
  /** How many recent Discord messages to pull, 1-100. */
  limit: z.number().int().min(1).max(100).optional(),
});
export type BridgeImportInput = z.infer<typeof bridgeImportSchema>;

export const updateProfileSchema = z
  .object({
    /** `null` (or an empty string) clears it and falls back to the username. */
    displayName: z.string().trim().max(LIMITS.displayName.max).nullable().optional(),
    /** When false the user neither sends nor sees typing indicators. */
    showTyping: z.boolean().optional(),
  })
  .refine((value) => value.displayName !== undefined || value.showTyping !== undefined, {
    message: 'Nothing to update.',
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** How long a moderation timeout lasts. */
export const timeoutSchema = z.object({
  durationMinutes: z.number().int().min(1).max(TIMEOUT_MAX_MINUTES),
});
export type TimeoutInput = z.infer<typeof timeoutSchema>;

/** The reason shown alongside a ban is optional. */
export const banSchema = z.object({
  reason: z.string().trim().max(300).nullable().optional(),
});
export type BanInput = z.infer<typeof banSchema>;
