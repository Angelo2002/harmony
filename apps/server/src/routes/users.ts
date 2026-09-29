import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission, permissionsToString, updateProfileSchema, type MeResponse } from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { findUserById, presentUser, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { UserService } from '../users/service.ts';

export interface UserRouteDeps {
  db: Database;
  users: UserService;
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  function present(row: UserRow): MeResponse {
    return {
      user: presentUser(deps.db.sqlite, row),
      permissions: permissionsToString(resolvePermissions(deps.db.sqlite, row)),
    };
  }

  app.patch('/api/v1/users/@me', async (request) => {
    const auth = requireAuth(request);
    const input = parseBody(updateProfileSchema, request.body);
    return present(deps.users.updateProfile(auth.user.id, input));
  });

  app.put('/api/v1/users/@me/avatar', async (request) => {
    const auth = requireAuth(request);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }
    const file = await request.file();
    if (!file) throw new HttpError(400, 'file_required', 'No image was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new HttpError(413, 'payload_too_large', 'That image is too large.');
    }

    return present(await deps.users.updateAvatar(auth.user.id, { contentType: file.mimetype, data }));
  });

  app.delete('/api/v1/users/@me/avatar', async (request) => {
    const auth = requireAuth(request);
    return present(deps.users.clearAvatar(auth.user.id));
  });

  app.get('/api/v1/users/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string };

    const row = findUserById(deps.db.sqlite, id);
    if (!row?.avatar_hash) {
      throw new HttpError(404, 'avatar_not_found', 'That user has no profile picture.');
    }

    // The content hash doubles as a capability: presenting it lets Discord fetch
    // an avatar without a session, while the route stays authenticated for
    // everyone else. Only avatars are exposed this way, never other uploads.
    const provided = (request.query as { v?: string }).v;
    if (provided !== row.avatar_hash) {
      requirePermission(request, Permission.ViewChannels);
    }

    const path = deps.users.avatarPath(row.avatar_hash);
    if (!existsSync(path)) {
      throw new HttpError(404, 'avatar_missing', 'That profile picture is missing from storage.');
    }

    // Always WebP: avatars are normalised on upload.
    reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${row.avatar_hash}"`);
    return reply.send(createReadStream(path));
  });
}
