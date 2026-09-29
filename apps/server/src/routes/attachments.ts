import { createReadStream, existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission } from '@harmony/shared';
import type { AttachmentService } from '../attachments/service.ts';
import { requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';

export interface AttachmentRouteDeps {
  service: AttachmentService;
  settings: SettingsService;
}

/** Parses a single-range `bytes=` header against a known size, or null. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  app.post('/api/v1/attachments', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }

    // The content type is not known until the part is read, so buffer up to the
    // larger configured limit and let the service apply the exact per-type one.
    const limits = deps.settings.get();
    const monitor = Math.max(limits.maxImageBytes, limits.maxVideoBytes);
    const file = await request.file({ limits: { fileSize: monitor, files: 1 } });
    if (!file) throw new HttpError(400, 'file_required', 'No file was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      // The multipart layer enforces the size limit while buffering.
      throw new HttpError(413, 'payload_too_large', 'That file is too large.');
    }

    return deps.service.upload(auth, { filename: file.filename, contentType: file.mimetype, data });
  });

  app.get('/api/v1/attachments/:id', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const attachment = deps.service.find(id);
    if (!attachment) throw new HttpError(404, 'attachment_not_found', 'That attachment does not exist.');

    const path = deps.service.filePathFor(attachment.hash);
    if (!existsSync(path)) throw new HttpError(404, 'attachment_missing', 'That file is missing from storage.');

    // Blobs are content-addressed, so a given id's bytes never change.
    reply
      .header('Content-Type', attachment.content_type)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Accept-Ranges', 'bytes')
      .header('ETag', `"${attachment.hash}"`);

    // Video players seek with range requests, and Safari will not start playback
    // without them, so honour a single range when one is asked for.
    const size = statSync(path).size;
    const range = request.headers.range !== undefined ? parseRange(request.headers.range, size) : null;
    if (range) {
      reply
        .code(206)
        .header('Content-Length', String(range.end - range.start + 1))
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      return reply.send(createReadStream(path, { start: range.start, end: range.end }));
    }

    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(path));
  });
}
