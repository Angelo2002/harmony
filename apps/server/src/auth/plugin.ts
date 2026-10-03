import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasAnyPermission, hasPermission, type PermissionValue } from '@harmony/shared';
import { HttpError } from '../http/errors.ts';
import type { AuthContext } from './service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook; `null` when the request is anonymous. */
    auth: AuthContext | null;
  }
}

export interface AuthPluginOptions {
  cookieName: string;
  resolveToken: (token: string) => AuthContext | null;
}

/** Reads a bearer token from the `Authorization` header, falling back to the session cookie. */
export function extractToken(request: FastifyRequest, cookieName: string): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return request.cookies[cookieName] ?? null;
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const token = extractToken(request, options.cookieName);
    request.auth = token ? options.resolveToken(token) : null;
  });
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'unauthorized', 'You need to be signed in.');
  return request.auth;
}

export function requirePermission(request: FastifyRequest, permission: PermissionValue): AuthContext {
  const auth = requireAuth(request);
  if (!hasPermission(auth.permissions, permission)) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  }
  return auth;
}

/** Like `requirePermission`, but passes when the member holds any one of `permissions`. */
export function requireAnyPermission(
  request: FastifyRequest,
  permissions: readonly PermissionValue[],
): AuthContext {
  const auth = requireAuth(request);
  if (!hasAnyPermission(auth.permissions, permissions)) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  }
  return auth;
}
