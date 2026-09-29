import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission } from '@harmony/shared';
import type { AttachmentService } from '../attachments/service.ts';
import { requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';

export function registerAttachmentRoutes(app: FastifyInstance, service: AttachmentService): void {
  app.post('/api/v1/attachments', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }

    const file = await request.file();
    if (!file) throw new HttpError(400, 'file_required', 'No file was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      // The multipart layer enforces the size limit while buffering.
      throw new HttpError(413, 'payload_too_large', 'That image is too large.');
    }

    return service.upload(auth, { filename: file.filename, contentType: file.mimetype, data });
  });

  app.get('/api/v1/attachments/:id', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const attachment = service.find(id);
    if (!attachment) throw new HttpError(404, 'attachment_not_found', 'That attachment does not exist.');

    const path = service.filePathFor(attachment.hash);
    if (!existsSync(path)) {
      throw new HttpError(404, 'attachment_missing', 'That file is missing from storage.');
    }

    // Blobs are content-addressed, so a given id's bytes never change.
    reply
      .header('Content-Type', attachment.content_type)
      .header('Content-Length', String(attachment.size))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${attachment.hash}"`);
    return reply.send(createReadStream(path));
  });
}
