import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.ts';

function sessionCookieOptions(config: Config): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlDays * 86_400,
  };
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(config.cookieName, token, sessionCookieOptions(config));
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.cookieName, { path: '/' });
}
