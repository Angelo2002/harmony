import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import type { StickerService } from '../stickers/service.ts';

export interface StickerRouteDeps {
  service: StickerService;
}

export function registerStickerRoutes(app: FastifyInstance, deps: StickerRouteDeps): void {
  app.get('/api/v1/stickers/:id', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const sticker = deps.service.find(id);
    if (!sticker) throw new HttpError(404, 'sticker_not_found', 'That sticker does not exist.');

    const path = deps.service.pathFor(sticker.hash);
    if (!existsSync(path)) {
      throw new HttpError(404, 'sticker_missing', 'That sticker image is missing from storage.');
    }

    reply
      .header('Content-Type', sticker.content_type)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${sticker.hash}"`);
    return reply.send(createReadStream(path));
  });
}
