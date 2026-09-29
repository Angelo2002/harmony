import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { GATEWAY_HEARTBEAT_MS } from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { createAuthService } from './auth/service.ts';
import { registerAuth } from './auth/plugin.ts';
import { createSettingsService } from './settings/service.ts';
import { createAttachmentService } from './attachments/service.ts';
import { createEmojiService } from './emojis/service.ts';
import { createMessageService } from './messages/service.ts';
import { GatewayHub } from './realtime/hub.ts';
import { createPruner } from './retention/pruner.ts';
import { createBridgeService } from './bridge/service.ts';
import { createDiscordTransport } from './bridge/discordjs.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerRoleRoutes } from './routes/roles.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerEmojiRoutes } from './routes/emojis.ts';
import { registerRetentionRoutes } from './routes/retention.ts';
import { registerBridgeRoutes } from './routes/bridge.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
const db = new Database(config);
const hub = new GatewayHub();
const settingsService = createSettingsService(db.sqlite, {
  serverName: config.serverName,
  requireInvite: config.requireInvite,
});
const authService = createAuthService(db.sqlite, config, settingsService);
const attachmentService = createAttachmentService(db.sqlite, config);
const emojiService = createEmojiService(db.sqlite, config);
const messageService = createMessageService(db.sqlite, hub);

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

const pruner = createPruner({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

const bridgeLogger = {
  info: (message: string, detail?: unknown) => app.log.info(detail ?? {}, message),
  debug: (message: string, detail?: unknown) => app.log.debug(detail ?? {}, message),
};

const bridge = createBridgeService({
  sqlite: db.sqlite,
  settings: settingsService,
  messages: messageService,
  logger: bridgeLogger,
  transportFactory: (token, logger) => createDiscordTransport(token, logger),
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
await app.register(websocket);

registerErrorHandler(app);
registerAuth(app, { cookieName: config.cookieName, resolveToken: authService.resolveToken });

registerHealthRoutes(app, db);
registerMetaRoutes(app, { config, settings: settingsService });
registerAuthRoutes(app, { service: authService, config });
registerSettingsRoutes(app, settingsService);
registerRetentionRoutes(app, { settings: settingsService, pruner });
registerBridgeRoutes(app, { settings: settingsService, bridge });
registerRoleRoutes(app, { db, hub });
registerMemberRoutes(app, { db, hub });
registerInviteRoutes(app, db);
registerChannelRoutes(app, { db, hub });
registerMessageRoutes(app, { service: messageService });
registerAttachmentRoutes(app, attachmentService);
registerEmojiRoutes(app, { service: emojiService, hub });
registerGateway(app, {
  heartbeatIntervalMs: GATEWAY_HEARTBEAT_MS,
  cookieName: config.cookieName,
  resolveToken: authService.resolveToken,
  hub,
});

app.addHook('onClose', async () => {
  pruner.stop();
  await bridge.shutdown();
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

// Pruning runs once at startup, then on the configured interval.
pruner.start();

// Connect the Discord bot if the bridge was left enabled.
await bridge.applySettings();
