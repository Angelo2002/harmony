import type { FastifyInstance } from 'fastify';
import { loginSchema, permissionsToString, registerSchema, type MeResponse } from '@harmony/shared';
import type { Config } from '../config.ts';
import type { AuthService } from '../auth/service.ts';
import { extractToken, requireAuth } from '../auth/plugin.ts';
import { withDiscordId } from '../db/users.ts';
import { clearSessionCookie, setSessionCookie } from '../http/cookies.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';

export interface AuthRouteDeps {
  service: AuthService;
  config: Config;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  // Login carries two independent budgets, because one key alone is always
  // something the client can vary. The address budget is the coarse signal: it
  // catches one source spraying across many accounts. The account budget is
  // keyed on the submitted username and is the one that bounds guessing against
  // a single known account, since it cannot be escaped by changing address.
  //
  // The account budget matters in particular behind a reverse proxy. When
  // HARMONY_TRUST_PROXY is on, request.ip comes from X-Forwarded-For, so a
  // proxy that forwards the header without overwriting it lets a client forge
  // a fresh address on every request and slip the address budget; the account
  // budget still holds. Both budgets are in-memory and per-process.
  const loginAddressLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const loginAccountLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const registerLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

  app.post('/api/v1/auth/register', async (request, reply) => {
    registerLimiter.check(request.ip);
    const input = parseBody(registerSchema, request.body);
    const result = await deps.service.register(input, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, deps.config, result.token);
    return result;
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    // Charge the address budget before the body is parsed, so a flood stops
    // with the least work; then charge the account budget before the password
    // is verified, which is the expensive step.
    loginAddressLimiter.check(request.ip);
    const input = parseBody(loginSchema, request.body);
    // The account budget must fold case exactly as the NOCASE column does, or a
    // case variant is a fresh budget for the same account: findUserByUsername
    // matches case-insensitively, so every spelling still verifies that one
    // account's password.
    loginAccountLimiter.check(input.username.toLowerCase());
    const result = await deps.service.login(input, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, deps.config, result.token);
    return result;
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = extractToken(request, deps.config.cookieName);
    if (token) deps.service.logout(token);
    clearSessionCookie(reply, deps.config);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const auth = requireAuth(request);
    // The member's own Discord id is theirs to see, so it rides on their own DTO.
    const body: MeResponse = {
      user: withDiscordId(auth.user, auth.discordId),
      permissions: permissionsToString(auth.permissions),
    };
    return body;
  });
}
