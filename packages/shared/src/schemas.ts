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
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const createMessageSchema = z.object({
  content: z.string().max(LIMITS.messageLength),
  attachmentIds: z.array(z.string()).max(LIMITS.attachmentsPerMessage).optional(),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createInviteSchema = z.object({
  /** `null`/absent means unlimited uses. */
  maxUses: z.number().int().positive().nullable().optional(),
  /** `null`/absent means the code never expires. */
  expiresInHours: z.number().positive().nullable().optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
