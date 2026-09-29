import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { GATEWAY_HEARTBEAT_MS } from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { createAuthService } from './auth/service.ts';
import { registerAuth } from './auth/plugin.ts';
import { createAttachmentService } from './attachments/service.ts';
import { createMessageService } from './messages/service.ts';
import { GatewayHub } from './realtime/hub.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
const db = new Database(config);
const hub = new GatewayHub();
const authService = createAuthService(db.sqlite, config);
const attachmentService = createAttachmentService(db.sqlite, config);
const messageService = createMessageService(db.sqlite, hub);

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
await app.register(websocket);

registerErrorHandler(app);
registerAuth(app, { cookieName: config.cookieName, resolveToken: authService.resolveToken });

registerHealthRoutes(app, db);
registerAuthRoutes(app, { service: authService, config });
registerInviteRoutes(app, db);
registerChannelRoutes(app, { db, hub });
registerMessageRoutes(app, { service: messageService });
registerAttachmentRoutes(app, attachmentService);
registerGateway(app, {
  heartbeatIntervalMs: GATEWAY_HEARTBEAT_MS,
  cookieName: config.cookieName,
  resolveToken: authService.resolveToken,
  hub,
});

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
