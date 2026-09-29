import type { FastifyInstance } from 'fastify';
import { loginSchema, permissionsToString, registerSchema, type MeResponse } from '@harmony/shared';
import type { Config } from '../config.ts';
import type { AuthService } from '../auth/service.ts';
import { extractToken, requireAuth } from '../auth/plugin.ts';
import { clearSessionCookie, setSessionCookie } from '../http/cookies.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';

export interface AuthRouteDeps {
  service: AuthService;
  config: Config;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const loginLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const registerLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

  app.post('/api/v1/auth/register', async (request, reply) => {
    registerLimiter.check(request.ip);
    const input = parseBody(registerSchema, request.body);
    const result = await deps.service.register(input, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, deps.config, result.token);
    return result;
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    loginLimiter.check(request.ip);
    const input = parseBody(loginSchema, request.body);
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
    const body: MeResponse = { user: auth.user, permissions: permissionsToString(auth.permissions) };
    return body;
  });
}
