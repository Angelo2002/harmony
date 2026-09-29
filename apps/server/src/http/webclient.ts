import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface WebClientOptions {
  /** The built client's directory, e.g. `apps/web/dist`. */
  dir: string;
}

/** Absolute path of the client's entry document, if a build is present. */
export function webClientIndex(dir: string): string | null {
  const index = join(dir, 'index.html');
  return existsSync(index) ? index : null;
}

/**
 * Serves the built single-page client, when one is present, so a production
 * instance is a single process on a single origin: the app, the API and the
 * gateway all share one address. Returns whether a build was found; without one
 * the client has to be served separately, which is what the Vite dev server
 * does.
 */
export async function registerWebClient(app: FastifyInstance, options: WebClientOptions): Promise<boolean> {
  if (webClientIndex(options.dir) === null) return false;

  await app.register(fastifyStatic, {
    root: options.dir,
    // Serve the shell for `/`; deeper client routes go through the SPA fallback.
    index: ['index.html'],
    setHeaders(response, path) {
      if (path.includes(`${sep}assets${sep}`)) {
        // Vite fingerprints everything under `assets/`, so it can be cached forever.
        response.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (path.endsWith(`${sep}index.html`) || path.endsWith(`${sep}sw.js`)) {
        // The shell names the current asset hashes, and the service worker has to
        // be re-checked for updates, so neither may be cached stale.
        response.header('Cache-Control', 'no-cache');
      } else {
        // The default icon and anything else unhashed gets a short cache.
        response.header('Cache-Control', 'public, max-age=3600');
      }
    },
  });

  return true;
}
