import type { DatabaseSync } from 'node:sqlite';
import { GatewayEvent, type PruneSummary, type RetentionUsage } from '@harmony/shared';
import type { Config } from '../config.ts';
import {
  countAttachments,
  deleteAttachmentsOlderThan,
  deleteOldestAttachments,
  deleteUnattachedAttachmentsOlderThan,
  listReferencedHashes,
} from '../db/attachments.ts';
import { countMessages, deleteMessagesOlderThan, deleteOldestMessages } from '../db/messages.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import { createBlobStore } from '../storage/blobs.ts';

/** Abandoned uploads (chosen but never sent) are dropped after this long. */
const UNATTACHED_UPLOAD_HOURS = 24;
const BATCH_SIZE = 200;
const MAX_BATCHES = 400;

export interface Pruner {
  usage(): RetentionUsage;
  lastRun(): PruneSummary | null;
  runNow(): PruneSummary;
  /** Runs once at startup and then on the configured interval. */
  start(): void;
  stop(): void;
}

export interface PrunerDeps {
  sqlite: DatabaseSync;
  config: Config;
  settings: SettingsService;
  hub: GatewayHub;
  log: (message: string, detail?: unknown) => void;
}

export function createPruner(deps: PrunerDeps): Pruner {
  const blobs = createBlobStore(deps.config);
  let last: PruneSummary | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  function isoHoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }

  /**
   * Deletes on-disk blobs that no row references any more. Because storage is
   * content-addressed, a blob only goes once its last reference is gone.
   */
  function sweepUnreferencedBlobs(): { count: number; bytes: number } {
    const referenced = listReferencedHashes(deps.sqlite);
    let count = 0;
    let bytes = 0;

    for (const hash of blobs.listHashes()) {
      if (referenced.has(hash)) continue;
      bytes += blobs.delete(hash);
      count += 1;
    }
    return { count, bytes };
  }

  function usage(): RetentionUsage {
    return {
      blobBytes: blobs.totalBytes(),
      attachmentCount: countAttachments(deps.sqlite),
      messageCount: countMessages(deps.sqlite),
    };
  }

  function runNow(): PruneSummary {
    const settings = deps.settings.getRetention();
    let deletedAttachments = 0;
    let deletedMessages = 0;
    let deletedBlobs = 0;
    let freedBytes = 0;

    if (settings.imageRetentionDays !== null) {
      deletedAttachments += deleteAttachmentsOlderThan(deps.sqlite, isoDaysAgo(settings.imageRetentionDays));
    }

    if (settings.messageRetentionDays !== null) {
      deletedMessages += deleteMessagesOlderThan(deps.sqlite, isoDaysAgo(settings.messageRetentionDays));
    }

    // Uploads that never turned into a message.
    deletedAttachments += deleteUnattachedAttachmentsOlderThan(deps.sqlite, isoHoursAgo(UNATTACHED_UPLOAD_HOURS));

    // Realise whatever the deletions above freed.
    let swept = sweepUnreferencedBlobs();
    deletedBlobs += swept.count;
    freedBytes += swept.bytes;

    // Emergency pruning: evict oldest content until back under the target.
    if (settings.storageLimitBytes !== null) {
      const target =
        settings.storageTargetBytes !== null
          ? Math.min(settings.storageTargetBytes, settings.storageLimitBytes)
          : settings.storageLimitBytes;

      let current = blobs.totalBytes();
      let batches = 0;

      while (current > target && batches < MAX_BATCHES) {
        batches += 1;

        const removedAttachments = deleteOldestAttachments(deps.sqlite, BATCH_SIZE);
        const removedMessages = removedAttachments === 0 ? deleteOldestMessages(deps.sqlite, BATCH_SIZE) : 0;
        if (removedAttachments === 0 && removedMessages === 0) break; // nothing left to evict

        deletedAttachments += removedAttachments;
        deletedMessages += removedMessages;

        swept = sweepUnreferencedBlobs();
        deletedBlobs += swept.count;
        freedBytes += swept.bytes;
        current -= swept.bytes;
      }

      // The final message deletions may have cascaded attachments; sweep again.
      swept = sweepUnreferencedBlobs();
      deletedBlobs += swept.count;
      freedBytes += swept.bytes;
    }

    const summary: PruneSummary = {
      ranAt: new Date().toISOString(),
      deletedAttachments,
      deletedMessages,
      deletedBlobs,
      freedBytes,
    };
    last = summary;

    if (deletedAttachments > 0 || deletedMessages > 0 || deletedBlobs > 0) {
      deps.hub.dispatch(GatewayEvent.RetentionApplied, summary);
      deps.log('retention removed content', summary);
    }
    return summary;
  }

  return {
    usage,
    lastRun: () => last,
    runNow,

    start() {
      if (timer) return;

      try {
        runNow();
      } catch (error) {
        deps.log('initial retention run failed', error);
      }

      timer = setInterval(
        () => {
          try {
            runNow();
          } catch (error) {
            deps.log('retention run failed', error);
          }
        },
        Math.max(1, deps.config.pruneIntervalMinutes) * 60_000,
      );
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
