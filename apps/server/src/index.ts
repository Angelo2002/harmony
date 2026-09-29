import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { GATEWAY_HEARTBEAT_MS } from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { canSeeResource, channelAccessFor } from './access/service.ts';
import { createAuthService } from './auth/service.ts';
import { registerAuth } from './auth/plugin.ts';
import { createAuditService } from './audit/service.ts';
import { createSettingsService } from './settings/service.ts';
import { createIconService } from './settings/icon.ts';
import { createAttachmentService } from './attachments/service.ts';
import { createEmojiService } from './emojis/service.ts';
import { createEmojiImportService } from './emojis/import.ts';
import { createUserService } from './users/service.ts';
import { createMessageService } from './messages/service.ts';
import { GatewayHub } from './realtime/hub.ts';
import { createPruner } from './retention/pruner.ts';
import { createBridgeService } from './bridge/service.ts';
import { createDiscordTransport } from './bridge/discordjs.ts';
import { createChannelImportService } from './channels/import.ts';
import { createEmbedService } from './embeds/service.ts';
import { createModerationService } from './moderation/service.ts';
import { createMediaService } from './media/service.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerIconRoutes } from './routes/icon.ts';
import { registerRoleRoutes } from './routes/roles.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerEmojiRoutes } from './routes/emojis.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerRetentionRoutes } from './routes/retention.ts';
import { registerBridgeRoutes } from './routes/bridge.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
const db = new Database(config);
const hub = new GatewayHub();
// Locked channels stay out of the gateway traffic of members who cannot see them.
hub.setVisibilityResolver((userId, visibility) =>
  canSeeResource(db.sqlite, channelAccessFor(db.sqlite, userId), visibility),
);
const settingsService = createSettingsService(db.sqlite, {
  serverName: config.serverName,
  requireInvite: config.requireInvite,
  defaultChannelId: null,
  embedsEnabled: true,
  theme: { background: null, accent: null },
});
const authService = createAuthService(db.sqlite, config, settingsService);
const auditService = createAuditService(db.sqlite);
const attachmentService = createAttachmentService(db.sqlite, config);
const emojiService = createEmojiService(db.sqlite, config);
const iconService = createIconService(config, settingsService);
const userService = createUserService(db.sqlite, config);
const messageService = createMessageService(db.sqlite, hub, auditService);
const moderationService = createModerationService({ sqlite: db.sqlite, hub, audit: auditService });
const mediaService = createMediaService(db.sqlite, config);

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

const pruner = createPruner({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

// Unfurls one link per message into a small preview. It listens for local
// messages only and pushes updates straight to the gateway, so the bridge never
// mistakes a preview for a user edit.
const embedService = createEmbedService({
  sqlite: db.sqlite,
  settings: settingsService,
  hub,
  renderMessage: (messageId) => messageService.byId(messageId),
  log: (message, detail) => app.log.debug(detail ?? {}, message),
});
messageService.onMessageCreated((message) => embedService.resolve(message.id, message.content));
messageService.onMessageEdited((message) => embedService.resolve(message.id, message.content));

const bridgeLogger = {
  info: (message: string, detail?: unknown) => app.log.info(detail ?? {}, message),
  debug: (message: string, detail?: unknown) => app.log.debug(detail ?? {}, message),
};

const bridge = createBridgeService({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  messages: messageService,
  users: userService,
  logger: bridgeLogger,
  transportFactory: (token, logger) => createDiscordTransport(token, logger),
});

// Copies the linked guild's custom emoji in on demand from the emoji panel.
const emojiImport = createEmojiImportService({
  emojis: emojiService,
  bridge,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

// Recreates the linked guild's channels, bridging each one, from the channels panel.
const channelImport = createChannelImportService({
  sqlite: db.sqlite,
  bridge,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
await app.register(websocket);

registerErrorHandler(app);
registerAuth(app, { cookieName: config.cookieName, resolveToken: authService.resolveToken });

registerHealthRoutes(app, db);
registerMetaRoutes(app, { config, settings: settingsService });
registerAuthRoutes(app, { service: authService, config });
registerSettingsRoutes(app, { settings: settingsService, db });
registerIconRoutes(app, { icon: iconService });
registerRetentionRoutes(app, { settings: settingsService, pruner });
registerAuditRoutes(app, { audit: auditService });
registerBridgeRoutes(app, { settings: settingsService, bridge });
registerRoleRoutes(app, { db, hub });
registerMemberRoutes(app, { db, hub, moderation: moderationService, audit: auditService });
registerInviteRoutes(app, db);
registerChannelRoutes(app, { db, hub, bridge, settings: settingsService, importer: channelImport });
registerMessageRoutes(app, { service: messageService });
registerAttachmentRoutes(app, attachmentService);
registerMediaRoutes(app, { service: mediaService, audit: auditService });
registerEmojiRoutes(app, { service: emojiService, importer: emojiImport, hub });
registerUserRoutes(app, { db, users: userService });
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
