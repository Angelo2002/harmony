import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthResponse, LoginInput, PermissionValue, RegisterInput, User } from '@harmony/shared';
import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import {
  countUsers,
  findUserById,
  findUserByUsername,
  insertUser,
  toUser,
  type UserRow,
} from '../db/users.ts';
import {
  deleteSessionById,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  insertSession,
  touchSession,
} from '../db/sessions.ts';
import { findInvite, incrementInviteUses } from '../db/invites.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './passwords.ts';
import { generateSessionToken, hashSessionToken } from './tokens.ts';
import { resolvePermissions } from './permissions.ts';

export interface AuthContext {
  user: User;
  permissions: PermissionValue;
  sessionId: string;
  token: string;
}

export interface AuthService {
  register(input: RegisterInput, userAgent: string | null): Promise<AuthResponse>;
  login(input: LoginInput, userAgent: string | null): Promise<AuthResponse>;
  logout(token: string): void;
  resolveToken(token: string): AuthContext | null;
}

export function createAuthService(sqlite: DatabaseSync, config: Config): AuthService {
  function issueSession(user: UserRow, userAgent: string | null): string {
    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 86_400_000).toISOString();

    insertSession(sqlite, {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      userAgent,
      createdAt: now.toISOString(),
      expiresAt,
    });

    return token;
  }

  return {
    async register(input, userAgent) {
      if (findUserByUsername(sqlite, input.username)) {
        throw new HttpError(409, 'username_taken', 'That username is already taken.');
      }

      // The very first account bootstraps the instance and becomes the owner.
      const isFirstUser = countUsers(sqlite) === 0;
      let inviteCodeToConsume: string | null = null;

      if (!isFirstUser && config.requireInvite) {
        if (!input.inviteCode) {
          throw new HttpError(403, 'invite_required', 'An invite code is required to register.');
        }

        const invite = findInvite(sqlite, input.inviteCode);
        if (!invite) throw new HttpError(403, 'invalid_invite', 'That invite code is not valid.');
        if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
          throw new HttpError(403, 'invite_expired', 'That invite code has expired.');
        }
        if (invite.max_uses != null && invite.uses >= invite.max_uses) {
          throw new HttpError(403, 'invite_exhausted', 'That invite code has already been used up.');
        }

        inviteCodeToConsume = invite.code;
      }

      const id = randomUUID();
      const passwordHash = await hashPassword(input.password);
      insertUser(sqlite, { id, username: input.username, passwordHash, isOwner: isFirstUser });
      if (inviteCodeToConsume) incrementInviteUses(sqlite, inviteCodeToConsume);

      const row = findUserById(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to load the new account.');

      return { user: toUser(row), token: issueSession(row, userAgent) };
    },

    async login(input, userAgent) {
      const row = findUserByUsername(sqlite, input.username);
      // Always hash-compare, even for unknown users, to avoid leaking which
      // usernames exist via response timing.
      const ok = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!row || !ok) {
        throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
      }

      return { user: toUser(row), token: issueSession(row, userAgent) };
    },

    logout(token) {
      deleteSessionByTokenHash(sqlite, hashSessionToken(token));
    },

    resolveToken(token) {
      const session = findSessionByTokenHash(sqlite, hashSessionToken(token));
      if (!session) return null;

      if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
        deleteSessionById(sqlite, session.id);
        return null;
      }

      const row = findUserById(sqlite, session.user_id);
      if (!row) return null;

      touchSession(sqlite, session.id);
      return {
        user: toUser(row),
        permissions: resolvePermissions(sqlite, row),
        sessionId: session.id,
        token,
      };
    },
  };
}
