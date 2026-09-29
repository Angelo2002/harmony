import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { GATEWAY_HEARTBEAT_MS } from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { createAuthService } from './auth/service.ts';
import { registerAuth } from './auth/plugin.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
const db = new Database(config);
const authService = createAuthService(db.sqlite, config);

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

await app.register(cookie);
await app.register(websocket);

registerErrorHandler(app);
registerAuth(app, { cookieName: config.cookieName, resolveToken: authService.resolveToken });

registerHealthRoutes(app, db);
registerAuthRoutes(app, { service: authService, config });
registerInviteRoutes(app, db);
registerGateway(app, { heartbeatIntervalMs: GATEWAY_HEARTBEAT_MS, resolveToken: authService.resolveToken });

app.addHook('onClose', async () => {
  db.close();
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`Harmony is listening on ${address}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
