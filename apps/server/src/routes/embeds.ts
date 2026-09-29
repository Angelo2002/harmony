import type { FastifyInstance } from 'fastify';
import { Permission } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { fetchEmbedMedia } from '../embeds/media.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';

/** Harmony's own user agent, used when the admin has not chosen another. */
const DEFAULT_USER_AGENT = 'Harmony/1.0 link-preview';

/**
 * Serves a link preview's image on the instance's behalf. A client never loads
 * one straight from the third party, so the viewer's address stays private and
 * an http-only image still shows on an https page.
 */
export function registerEmbedRoutes(app: FastifyInstance, deps: { settings: SettingsService }): void {
  app.get('/api/v1/embeds/media', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);

    const url = (request.query as { url?: string }).url;
    if (!url) throw new HttpError(400, 'url_required', 'A url query parameter is required.');

    const userAgent = deps.settings.get().previewUserAgent ?? DEFAULT_USER_AGENT;
    const media = await fetchEmbedMedia(url, userAgent);
    if (!media) throw new HttpError(404, 'media_unavailable', 'That preview image could not be loaded.');

    reply
      .header('Content-Type', media.contentType)
      // The bytes are a third party's; never let a browser second-guess the type.
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=86400');
    return reply.send(media.data);
  });
}
