import type { FastifyInstance } from 'fastify';
import { HARMONY_NAME, deriveTheme } from '@harmony/shared';
import type { IconService } from '../settings/icon.ts';
import type { SettingsService } from '../settings/service.ts';

export interface ManifestRouteDeps {
  settings: SettingsService;
  icon: IconService;
}

/**
 * The web app manifest, built from the instance's own settings so an installed
 * app carries the server's name, icon and colours rather than a fixed identity.
 * `display: standalone` is what makes the home-screen app open without browser
 * chrome. It is public, since a browser fetches it before anyone signs in.
 */
export function registerManifestRoutes(app: FastifyInstance, deps: ManifestRouteDeps): void {
  app.get('/manifest.webmanifest', async (request, reply) => {
    const settings = deps.settings.get();
    const name = settings.serverName || HARMONY_NAME;
    const theme = deriveTheme(settings.theme);
    // The icon URLs carry everything the rendered icon depends on, so a replaced
    // icon or a changed padding is a new URL and the long cache is safe.
    const version = deps.icon.version();

    reply
      .header('Content-Type', 'application/manifest+json')
      // Small and settings-driven, so revalidate rather than serve it stale.
      .header('Cache-Control', 'no-cache');

    return {
      name,
      short_name: name,
      description: `${name} — a self-hosted chat server.`,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: theme.bg,
      theme_color: theme.bg,
      icons: [
        { src: `/api/v1/icons/192?v=${version}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/api/v1/icons/512?v=${version}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: `/api/v1/icons/512?maskable=1&v=${version}`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    };
  });
}
