import type { DatabaseSync } from 'node:sqlite';
import {
  deletePushDevice,
  listPushDevices,
  upsertPushDevice,
  type PushDeviceRow,
} from '../db/push_devices.ts';

/**
 * Push-device registration: the endpoints a member's installs can be reached
 * at. Harmony records them per account so a member can be reached away from a
 * browser; it does not deliver yet, so nothing here sends. When a provider is
 * wired, `listForUser` is the fan-out point and the notification it sends is
 * `PushPayload` in `@harmony/shared`.
 */
export interface PushService {
  /** Registers an endpoint, or refreshes one already registered. */
  register(userId: string, input: { endpoint: string; platform: string }): void;
  /** Removes an endpoint; one that is not registered is fine. */
  remove(userId: string, endpoint: string): void;
  /** The endpoints registered by one member, newest first. */
  listForUser(userId: string): PushDeviceRow[];
}

export function createPushService(sqlite: DatabaseSync): PushService {
  return {
    register(userId, input) {
      upsertPushDevice(sqlite, userId, input.endpoint, input.platform, new Date().toISOString());
    },
    remove(userId, endpoint) {
      deletePushDevice(sqlite, userId, endpoint);
    },
    listForUser(userId) {
      return listPushDevices(sqlite, userId);
    },
  };
}
