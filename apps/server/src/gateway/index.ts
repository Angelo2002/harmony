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

export interface GatewayOptions {
  heartbeatIntervalMs: number;
  resolveToken: (token: string) => AuthContext | null;
}

/**
 * The realtime edge. Clients are greeted with HELLO, must IDENTIFY with a
 * session token, then receive READY. Event fan-out arrives with messaging.
 */
export function registerGateway(app: FastifyInstance, options: GatewayOptions): void {
  app.get('/gateway', { websocket: true }, (socket, request) => {
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
        const auth = identify?.token ? options.resolveToken(identify.token) : null;

        if (!auth) {
          socket.close(GatewayCloseCode.AuthenticationFailed, 'Invalid session');
          return;
        }

        const ready: GatewayReady = { user: auth.user, gateway_version: GATEWAY_VERSION };
        socket.send(JSON.stringify({ op: GatewayOp.Dispatch, t: GatewayEvent.Ready, d: ready }));
      }
    });

    socket.on('close', () => app.log.debug('gateway client disconnected'));
    socket.on('error', (error: Error) => app.log.error({ err: error }, 'gateway socket error'));
  });
}
