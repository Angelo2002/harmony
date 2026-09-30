import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  createEmojiSchema,
  emojiImportSchema,
  type DiscordEmojiListResponse,
  type EmojiImportResponse,
  type EmojiListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { EmojiImportService } from '../emojis/import.ts';
import type { EmojiService, EmojiUpload } from '../emojis/service.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface EmojiRouteDeps {
  service: EmojiService;
  importer: EmojiImportService;
  hub: GatewayHub;
}

export function registerEmojiRoutes(app: FastifyInstance, deps: EmojiRouteDeps): void {
  app.get('/api/v1/emojis', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const body: EmojiListResponse = { emojis: deps.service.list() };
    return body;
  });

  /** The linked Discord server's emoji, so an admin can see what an import would bring. */
  app.get('/api/v1/emojis/discord', async (request) => {
    requirePermission(request, Permission.ManageEmojis);
    const body: DiscordEmojiListResponse = await deps.importer.discordEmojis();
    return body;
  });

  /**
   * Copies every guild emoji Harmony does not already have. Safe to run again:
   * names that already exist are skipped, and each new emoji is announced on the
   * gateway like a manual upload.
   */
  app.post('/api/v1/emojis/import', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const input = parseBody(emojiImportSchema, request.body ?? {});
    const outcome = await deps.importer.importMissing(auth, input);

    for (const emoji of outcome.imported) deps.hub.dispatch(GatewayEvent.EmojiCreate, emoji);

    const body: EmojiImportResponse = {
      imported: outcome.imported.length,
      skipped: outcome.skipped,
      failed: outcome.failed,
    };
    return body;
  });

  app.post('/api/v1/emojis', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }

    // The name and the image can arrive in either order, so read every part.
    let name: string | null = null;
    let file: EmojiUpload | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'name') {
        name = String(part.value);
        continue;
      }
      if (part.type === 'file') {
        let data: Buffer;
        try {
          data = await part.toBuffer();
        } catch {
          throw new HttpError(413, 'payload_too_large', 'That emoji image is too large.');
        }
        file = { filename: part.filename, contentType: part.mimetype, data };
      }
    }

    if (!file || name == null) {
      throw new HttpError(400, 'invalid_upload', 'An emoji needs both a name and an image.');
    }

    const input = parseBody(createEmojiSchema, { name });
    const emoji = await deps.service.create(auth, input.name, file);
    deps.hub.dispatch(GatewayEvent.EmojiCreate, emoji);
    return emoji;
  });

  app.get('/api/v1/emojis/:id', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const emoji = deps.service.find(id);
    if (!emoji) throw new HttpError(404, 'emoji_not_found', 'That emoji does not exist.');

    const path = deps.service.pathFor(emoji.hash);
    if (!existsSync(path)) throw new HttpError(404, 'emoji_missing', 'That emoji image is missing from storage.');

    reply
      .header('Content-Type', emoji.content_type)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${emoji.hash}"`);
    return reply.send(createReadStream(path));
  });

  app.delete('/api/v1/emojis/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageEmojis);
    const { id } = request.params as { id: string };

    if (!deps.service.find(id)) throw new HttpError(404, 'emoji_not_found', 'That emoji does not exist.');

    deps.service.remove(id);
    deps.hub.dispatch(GatewayEvent.EmojiDelete, { id });
    return reply.status(204).send();
  });
}
