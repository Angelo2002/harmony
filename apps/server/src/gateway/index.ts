import type { FastifyInstance } from 'fastify';
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
import type { GatewayHub } from '../realtime/hub.ts';

export interface GatewayOptions {
  heartbeatIntervalMs: number;
  cookieName: string;
  resolveToken: (token: string) => AuthContext | null;
  hub: GatewayHub;
}

/**
 * The realtime edge. A client is greeted with HELLO, then must IDENTIFY:
 * either with a session token (API clients) or, for browser clients, by
 * relying on the session cookie presented during the WebSocket handshake.
 */
export function registerGateway(app: FastifyInstance, options: GatewayOptions): void {
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

    // Browser handshakes carry cookies, so allow cookie-based identification.
    const cookieToken = request.cookies?.[options.cookieName] ?? null;
    const cookieAuth = cookieToken ? options.resolveToken(cookieToken) : null;

    const hello: GatewayHello = {
      heartbeat_interval: options.heartbeatIntervalMs,
      gateway_version: GATEWAY_VERSION,
    };
    socket.send(JSON.stringify({ op: GatewayOp.Hello, d: hello }));
    app.log.debug({ ip: request.ip }, 'gateway client connected');

    socket.on('message', (raw: Buffer) => {
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
        const auth = identify?.token ? options.resolveToken(identify.token) : cookieAuth;

        if (!auth) {
          socket.close(GatewayCloseCode.AuthenticationFailed, 'Invalid session');
          return;
        }

        options.hub.authenticate(clientId, auth);
        const ready: GatewayReady = { user: auth.user, gateway_version: GATEWAY_VERSION };
        socket.send(JSON.stringify({ op: GatewayOp.Dispatch, t: GatewayEvent.Ready, d: ready }));
      }
    });

    socket.on('close', () => {
      options.hub.unregister(clientId);
      app.log.debug('gateway client disconnected');
    });
    socket.on('error', (error: Error) => app.log.error({ err: error }, 'gateway socket error'));
  });
}
