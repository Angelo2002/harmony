import { z } from 'zod';
import { LIMITS } from './constants.ts';

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
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  position: z.number().int().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  discordChannelId: z.string().nullable().optional(),
});
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const editMessageSchema = z.object({
  content: z.string().min(1).max(LIMITS.messageLength),
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const messageHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Return messages strictly older than this ISO timestamp. */
  before: z.string().optional(),
});
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

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

export const updateSettingsSchema = z.object({
  serverName: z.string().min(1).max(64).optional(),
  requireInvite: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const moveRoleSchema = z.object({
  direction: z.enum(['up', 'down']),
});
export type MoveRoleInput = z.infer<typeof moveRoleSchema>;

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
  messageRetentionDays: retentionNumber,
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

export const updateProfileSchema = z.object({
  /** `null` (or an empty string) clears it and falls back to the username. */
  displayName: z.string().trim().max(LIMITS.displayName.max).nullable(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
