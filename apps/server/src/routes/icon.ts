import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission, type InstanceIconResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import type { IconService } from '../settings/icon.ts';

export interface IconRouteDeps {
  icon: IconService;
}

/** Bounds for an on-demand icon render, wide enough for any launcher. */
const ICON_MIN_SIZE = 16;
const ICON_MAX_SIZE = 1024;

export function registerIconRoutes(app: FastifyInstance, deps: IconRouteDeps): void {
  /**
   * The instance icon. Public, because the browser fetches a favicon without a
   * session. A client asks for it with the current hash in `v`, which is what
   * lets a replaced icon take effect despite the long cache.
   */
  app.get('/api/v1/icon', async (request, reply) => {
    const hash = deps.icon.hash();
    if (!hash) throw new HttpError(404, 'icon_not_set', 'This instance uses the default icon.');

    const path = deps.icon.pathFor(hash);
    if (!existsSync(path)) throw new HttpError(404, 'icon_missing', 'The server icon is missing from storage.');

    reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', `"${hash}"`);
    return reply.send(createReadStream(path));
  });

  /**
   * The instance icon rendered at a given size, for the app manifest and the
   * home-screen icon. Public like the favicon above; the caller adds the current
   * icon hash to the URL, so the long cache is safe. Add `maskable=1` for the
   * padded variant Android crops to its own shape.
   */
  app.get('/api/v1/icons/:size', async (request, reply) => {
    const { size: rawSize } = request.params as { size: string };
    const size = Number(rawSize);
    if (!Number.isInteger(size) || size < ICON_MIN_SIZE || size > ICON_MAX_SIZE) {
      throw new HttpError(
        400,
        'invalid_size',
        `Icon size must be a whole number between ${ICON_MIN_SIZE} and ${ICON_MAX_SIZE}.`,
      );
    }

    const maskable = (request.query as { maskable?: string }).maskable === '1';
    const image = maskable ? await deps.icon.renderMaskable(size) : await deps.icon.render(size);
    if (!image) throw new HttpError(404, 'icon_unavailable', 'No server icon is available to render.');

    reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(image);
  });

  app.put('/api/v1/icon', async (request) => {
    requirePermission(request, Permission.ManageServer);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }

    let file: { contentType: string; data: Buffer } | null = null;
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      let data: Buffer;
      try {
        data = await part.toBuffer();
      } catch {
        throw new HttpError(413, 'payload_too_large', 'That image is too large.');
      }
      file = { contentType: part.mimetype, data };
    }
    if (!file) throw new HttpError(400, 'invalid_upload', 'An image file is required.');

    const body: InstanceIconResponse = { iconHash: await deps.icon.update(file) };
    return body;
  });

  app.delete('/api/v1/icon', async (request) => {
    requirePermission(request, Permission.ManageServer);
    deps.icon.clear();
    const body: InstanceIconResponse = { iconHash: null };
    return body;
  });
}
