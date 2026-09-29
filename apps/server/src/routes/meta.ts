import type { FastifyInstance } from 'fastify';
import { ALLOWED_IMAGE_TYPES, API_VERSION, LIMITS, type InstanceMeta } from '@harmony/shared';
import type { Config } from '../config.ts';
import type { SettingsService } from '../settings/service.ts';

/** Public, unauthenticated information a client needs before signing in. */
export function registerMetaRoutes(app: FastifyInstance, deps: { config: Config; settings: SettingsService }): void {
  app.get('/api/v1/meta', async () => {
    const settings = deps.settings.get();
    const body: InstanceMeta = {
      name: settings.serverName,
      apiVersion: API_VERSION,
      requireInvite: settings.requireInvite,
      theme: settings.theme,
      iconHash: deps.settings.getIconHash(),
      maxUploadBytes: deps.config.maxUploadBytes,
      allowedImageTypes: ALLOWED_IMAGE_TYPES,
      limits: {
        messageLength: LIMITS.messageLength,
        attachmentsPerMessage: LIMITS.attachmentsPerMessage,
        channelNameMax: LIMITS.channelName.max,
        usernameMin: LIMITS.username.min,
        usernameMax: LIMITS.username.max,
        passwordMin: LIMITS.password.min,
      },
    };
    return body;
  });
}
