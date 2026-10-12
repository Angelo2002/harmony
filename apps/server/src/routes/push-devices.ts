import type { FastifyInstance } from 'fastify';
import { registerPushDeviceSchema, removePushDeviceSchema } from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { PushService } from '../push/service.ts';

export interface PushRouteDeps {
  push: PushService;
}

/**
 * Per-account push-device registration. The endpoint is per install, so a
 * client registers it with every instance the member has added, and removes it
 * on sign-out or when the endpoint rotates.
 *
 * These routes only record the endpoint; delivery to it is not implemented yet.
 * Both are idempotent — registering twice refreshes, removing twice is a no-op —
 * so the shell can retry a registration without checking first.
 */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  // A shell registers on sign-in and again when the provider rotates the
  // endpoint, so a generous cap only stops a runaway retry loop.
  const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

  app.put('/api/v1/users/@me/push-devices', async (request) => {
    const auth = requireAuth(request);
    limiter.check(auth.user.id);
    const input = parseBody(registerPushDeviceSchema, request.body);
    deps.push.register(auth.user.id, input);
    return { ok: true };
  });

  app.delete('/api/v1/users/@me/push-devices', async (request) => {
    const auth = requireAuth(request);
    limiter.check(auth.user.id);
    const input = parseBody(removePushDeviceSchema, request.body);
    deps.push.remove(auth.user.id, input.endpoint);
    return { ok: true };
  });
}
