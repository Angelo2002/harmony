import type { FastifyInstance } from 'fastify';

/**
 * A strict policy for the single-page client. It loads only its own bundle and
 * stylesheet, talks only to its own API and gateway, and frames only the YouTube
 * player the link preview renders. `style-src` has to allow inline styles
 * because the client paints role colours and the theme through style attributes
 * and CSS custom properties.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com',
].join('; ');

export interface SecurityOptions {
  /** The `Content-Security-Policy` value, or null to leave the header off. */
  csp: string | null;
}

/** Adds the hardening headers a browser needs, to every response. */
export function registerSecurityHeaders(app: FastifyInstance, options: SecurityOptions): void {
  app.addHook('onSend', async (request, reply) => {
    // Stop a browser second-guessing a declared content type, which matters most
    // for the user-supplied images and videos the instance serves back.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    // Nothing here needs to tell an external site which channel a member is in.
    reply.header('Referrer-Policy', 'no-referrer');
    if (options.csp) reply.header('Content-Security-Policy', options.csp);
    // HSTS is only meaningful once the request really did arrive over TLS, which
    // `request.protocol` reports correctly when `trustProxy` is set.
    if (request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });
}

/** The addresses that mean "this machine only", where exposure is not a worry. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

export interface ExposureInfo {
  host: string;
  cookieSecure: boolean;
  requireInvite: boolean;
  userCount: number;
}

/**
 * Nags about the settings that turn a working instance into an unsafe one. Each
 * is only a warning: someone running on a trusted LAN may well mean it.
 */
export function warnAboutExposure(log: { warn: (message: string) => void }, info: ExposureInfo): void {
  if (info.userCount === 0) {
    log.warn(
      'No accounts exist yet. The first person to register becomes the owner, so finish setting up before exposing this instance to the internet.',
    );
  }
  if (!isLoopbackHost(info.host)) {
    if (!info.cookieSecure) {
      log.warn(
        `Listening on ${info.host} without Secure cookies. Serve this instance over HTTPS and set HARMONY_COOKIE_SECURE=true, or session cookies can be intercepted.`,
      );
    }
    if (!info.requireInvite) {
      log.warn(
        `Listening on ${info.host} with open registration: anyone who can reach the instance can create an account. Set HARMONY_REQUIRE_INVITE=true to make it invite-only.`,
      );
    }
  }
}
