import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { CHANNEL_EXPORT_FORMATS, Permission } from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import type { AuditService } from '../audit/service.ts';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import { channelExportHtml, channelExportJson } from '../backup/export.ts';
import { createBackupService, fileDate, fileSlug } from '../backup/service.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { findChannel } from '../db/channels.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';

export interface BackupRouteDeps {
  db: Database;
  config: Config;
  settings: SettingsService;
  audit: AuditService;
}

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const backups = createBackupService(deps.db.sqlite, deps.config);

  /**
   * The whole instance as a `.tar.gz`, streamed as it is built.
   *
   * Owner only, not Administrator. The archive is the database itself: every
   * password hash, every session token hash, the bridge bot token and the
   * Discord sign-in secret, and every message including deleted ones and those
   * in channels locked away from everyone. Administrator is a role anyone with
   * Manage Roles can be handed, and nothing else it grants lets someone walk
   * away with credentials to crack offline. The owner is the one account that
   * already stands in for whoever runs the machine.
   */
  app.get('/api/v1/backup', async (request, reply) => {
    const auth = requireAuth(request);
    if (!auth.user.isOwner) {
      throw new HttpError(403, 'owner_only', 'Only the owner can download a backup.');
    }

    const download = await backups.open(deps.settings.get().serverName);
    deps.audit.backupDownloaded(auth.user.id, download.filename);

    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${download.filename}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(download.stream);
  });

  /**
   * One channel's history as a file. `ManageServer` matches the audit log and
   * the media gallery, which already let the same people read everything that
   * was said. A locked channel the exporter cannot see is answered exactly like
   * a missing one, so the export cannot be used to discover it.
   */
  app.get('/api/v1/channels/:id/export', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageServer);
    const { id } = request.params as { id: string };
    const { format: rawFormat = 'json' } = request.query as { format?: string };
    const format = CHANNEL_EXPORT_FORMATS.find((candidate) => candidate === rawFormat);
    if (!format) throw new HttpError(400, 'invalid_format', 'Export format must be json or html.');

    const channel = findChannel(deps.db.sqlite, id);
    if (!channel || !canAccessChannel(deps.db.sqlite, channelAccessFor(deps.db.sqlite, auth.user.id), id)) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }

    const now = new Date();
    const serverName = deps.settings.get().serverName;
    const filename = `harmony-${fileSlug(serverName, 'server')}-${fileSlug(channel.name, 'channel')}-${fileDate(now)}.${format}`;
    // Attachment links point back at the address the export was asked for on,
    // which is the one the person downloading it knows the server by.
    const context = { serverName, origin: `${request.protocol}://${request.host}`, exportedAt: now };
    const body =
      format === 'html'
        ? channelExportHtml(deps.db.sqlite, channel, context)
        : channelExportJson(deps.db.sqlite, channel, context);

    deps.audit.channelExported(auth.user.id, channel.id, filename);

    reply
      .header('Content-Type', format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(Readable.from(body, { objectMode: false }));
  });
}
