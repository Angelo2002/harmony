import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  GATEWAY_VERSION,
  GatewayCloseCode,
  GatewayEvent,
  GatewayOp,
  type GatewayHello,
  type GatewayIdentify,
  type GatewayReady,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { withDiscordId } from '../db/users.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface GatewayOptions {
  heartbeatIntervalMs: number;
  cookieName: string;
  resolveToken: (token: string) => AuthContext | null;
  hub: GatewayHub;
  /**
   * Called when a member's last connection drops, so anything tied to being
   * connected (their seat in a voice channel) can be released. A member with
   * another tab still open does not trigger it.
   */
  onUserOffline?: (userId: string) => void;
}

/**
 * Whether a cookie-authenticated browser handshake came from this instance's
 * own origin. Harmony serves the client, API and gateway from one origin, so
 * the origin the handshake arrived on is the instance origin; a page on another
 * site opens its WebSocket with that page's origin instead. Comparing the two
 * refuses a cross-site handshake that arrives carrying the victim's session
 * cookie (cross-site WebSocket hijacking), even if some future change to the
 * cookie's `SameSite` attribute would otherwise let it ride along.
 *
 * `request.host` and `request.protocol` respect `X-Forwarded-Host` and
 * `X-Forwarded-Proto` when `trustProxy` is on, so a reverse proxy still reports
 * the public origin. An absent or unparseable `Origin` (including the literal
 * "null" a sandboxed frame sends) is refused: every current browser sends one
 * on a WebSocket handshake, and a non-browser client should identify with an
 * explicit token instead.
 */
function isInstanceOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  let candidate: string;
  try {
    // Normalizes the scheme/host case and drops any path or fragment.
    candidate = new URL(origin).origin;
  } catch {
    return false;
  }
  const expected = `${request.protocol}://${request.host}`;
  return candidate.toLowerCase() === expected.toLowerCase();
}

/**
 * The realtime edge. A client is greeted with HELLO, then must IDENTIFY:
 * either with a session token (API clients) or, for browser clients, by
 * relying on the session cookie presented during the WebSocket handshake.
 *
 * After that the client heartbeats. A socket can die without either end being
 * told (a phone dropping off the network, a laptop lid closing), and until it is
 * closed its member stays online and its slot stays taken. So a connection that
 * goes quiet for about two heartbeat intervals is presumed dead and closed, and
 * one that never identifies is closed after a single interval.
 */
export function registerGateway(app: FastifyInstance, options: GatewayOptions): void {
  const interval = options.heartbeatIntervalMs;
  // Two missed beats, plus room for a slow network or a throttled background
  // tab delivering one late, before giving up on a connection.
  const silenceLimitMs = interval * 2 + Math.min(interval, 5000);

  app.get('/gateway', { websocket: true }, (socket, request) => {
    const clientId = options.hub.register(
      (payload) => {
        try {
          socket.send(payload);
        } catch {
          // Socket is closing; its close handler will unregister it.
        }
      },
      (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          // Already closing.
        }
      },
    );

    let identified = false;
    // Kept for the close handler: a dropped connection releases the member's
    // voice seat, but only once their last connection is gone.
    let identifiedUserId: string | null = null;
    const identifyTimer = setTimeout(() => {
      if (!identified) socket.close(GatewayCloseCode.NotAuthenticated, 'Identify timed out');
    }, interval);

    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pushes the deadline back whenever the client shows it is still there. */
    const heardFrom = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        socket.close(GatewayCloseCode.SessionTimedOut, 'Heartbeat timed out');
        // A dead peer never completes the closing handshake, and the socket would
        // linger (and keep its member online) until TCP gives up. Cut it loose.
        setTimeout(() => socket.terminate(), 5000).unref();
      }, silenceLimitMs);
    };
    heardFrom();

    // Browser handshakes carry cookies, so allow cookie-based identification.
    const cookieToken = request.cookies?.[options.cookieName] ?? null;
    const cookieAuth = cookieToken ? options.resolveToken(cookieToken) : null;

    const hello: GatewayHello = {
      heartbeat_interval: interval,
      gateway_version: GATEWAY_VERSION,
    };
    socket.send(JSON.stringify({ op: GatewayOp.Hello, d: hello }));
    app.log.debug({ ip: request.ip }, 'gateway client connected');

    socket.on('message', (raw: Buffer) => {
      heardFrom();

      let frame: { op?: number; d?: unknown };
      try {
        frame = JSON.parse(raw.toString()) as { op?: number; d?: unknown };
      } catch {
        return; // Ignore malformed frames instead of tearing down the socket.
      }

      if (frame.op === GatewayOp.Heartbeat) {
        socket.send(JSON.stringify({ op: GatewayOp.HeartbeatAck, d: null }));
        return;
      }

      if (frame.op === GatewayOp.Identify) {
        const identify = frame.d as GatewayIdentify | undefined;
        const fromToken = Boolean(identify?.token);
        const auth = identify?.token ? options.resolveToken(identify.token) : cookieAuth;

        if (!auth) {
          socket.close(GatewayCloseCode.AuthenticationFailed, 'Your session has ended. Please sign in again.');
          return;
        }

        // Defense-in-depth against cross-site WebSocket hijacking: a handshake
        // that leans on the session cookie must come from this instance's own
        // origin. A client that identifies with an explicit token is not
        // origin-bound and is unaffected.
        if (!fromToken && !isInstanceOrigin(request)) {
          app.log.warn(
            { origin: request.headers.origin ?? null, expected: `${request.protocol}://${request.host}` },
            'gateway cookie handshake rejected: cross-site origin',
          );
          socket.close(GatewayCloseCode.AuthenticationFailed, 'Your session has ended. Please sign in again.');
          return;
        }

        identified = true;
        identifiedUserId = auth.user.id;
        clearTimeout(identifyTimer);
        options.hub.authenticate(clientId, auth);
        const ready: GatewayReady = {
          user: withDiscordId(auth.user, auth.discordId),
          gateway_version: GATEWAY_VERSION,
        };
        socket.send(JSON.stringify({ op: GatewayOp.Dispatch, t: GatewayEvent.Ready, d: ready }));
      }
    });

    socket.on('close', () => {
      clearTimeout(identifyTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      options.hub.unregister(clientId);
      if (identifiedUserId && !options.hub.onlineUserIds().has(identifiedUserId)) {
        options.onUserOffline?.(identifiedUserId);
      }
      app.log.debug('gateway client disconnected');
    });
    socket.on('error', (error: Error) => app.log.error({ err: error }, 'gateway socket error'));
  });
}
