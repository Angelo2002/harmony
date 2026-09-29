import type { DatabaseSync } from 'node:sqlite';
import type { RetentionSettings } from '@harmony/shared';
import { readAllSettings, writeSetting } from '../db/settings.ts';

export interface ServerSettings {
  serverName: string;
  requireInvite: boolean;
}

export interface BridgeSettings {
  /** Bot token, or null when the bridge has never been configured. */
  token: string | null;
  enabled: boolean;
}

/** Bridge settings safe to hand to the client: never includes the token. */
export interface BridgePublicSettings {
  configured: boolean;
  enabled: boolean;
}

export interface SettingsService {
  get(): ServerSettings;
  update(patch: Partial<ServerSettings>): ServerSettings;
  getRetention(): RetentionSettings;
  updateRetention(patch: Partial<RetentionSettings>): RetentionSettings;
  getBridge(): BridgeSettings;
  getBridgePublic(): BridgePublicSettings;
  updateBridge(patch: { token?: string; enabled?: boolean }): BridgePublicSettings;
}

const KEY_SERVER_NAME = 'server_name';
const KEY_REQUIRE_INVITE = 'require_invite';
const KEY_IMAGE_DAYS = 'retention_image_days';
const KEY_MESSAGE_DAYS = 'retention_message_days';
const KEY_STORAGE_LIMIT = 'storage_limit_bytes';
const KEY_STORAGE_TARGET = 'storage_target_bytes';
const KEY_DISCORD_TOKEN = 'discord_bot_token';
const KEY_BRIDGE_ENABLED = 'bridge_enabled';

function parseString(raw: string, fallback: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : fallback;
  } catch {
    return fallback;
  }
}

function parseBoolean(raw: string, fallback: boolean): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}

/** A number, or `null` meaning the rule is switched off. */
function parseNumberOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function parseStringOrNull(raw: string | undefined): string | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Instance settings live in the database so admins can change them at runtime.
 * Environment values only provide the initial defaults.
 */
export function createSettingsService(sqlite: DatabaseSync, defaults: ServerSettings): SettingsService {
  function get(): ServerSettings {
    const stored = readAllSettings(sqlite);
    const name = stored.get(KEY_SERVER_NAME);
    const requireInvite = stored.get(KEY_REQUIRE_INVITE);

    return {
      serverName: name ? parseString(name, defaults.serverName) : defaults.serverName,
      requireInvite: requireInvite ? parseBoolean(requireInvite, defaults.requireInvite) : defaults.requireInvite,
    };
  }

  function getRetention(): RetentionSettings {
    const stored = readAllSettings(sqlite);
    return {
      imageRetentionDays: parseNumberOrNull(stored.get(KEY_IMAGE_DAYS)),
      messageRetentionDays: parseNumberOrNull(stored.get(KEY_MESSAGE_DAYS)),
      storageLimitBytes: parseNumberOrNull(stored.get(KEY_STORAGE_LIMIT)),
      storageTargetBytes: parseNumberOrNull(stored.get(KEY_STORAGE_TARGET)),
    };
  }

  function getBridge(): BridgeSettings {
    const stored = readAllSettings(sqlite);
    const enabled = stored.get(KEY_BRIDGE_ENABLED);
    return {
      token: parseStringOrNull(stored.get(KEY_DISCORD_TOKEN)),
      enabled: enabled ? parseBoolean(enabled, false) : false,
    };
  }

  function getBridgePublic(): BridgePublicSettings {
    const bridge = getBridge();
    return { configured: bridge.token !== null, enabled: bridge.enabled };
  }

  return {
    get,
    getRetention,
    getBridge,
    getBridgePublic,

    update(patch) {
      if (patch.serverName !== undefined) writeSetting(sqlite, KEY_SERVER_NAME, JSON.stringify(patch.serverName));
      if (patch.requireInvite !== undefined) {
        writeSetting(sqlite, KEY_REQUIRE_INVITE, JSON.stringify(patch.requireInvite));
      }
      return get();
    },

    updateRetention(patch) {
      if (patch.imageRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_IMAGE_DAYS, JSON.stringify(patch.imageRetentionDays));
      }
      if (patch.messageRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_MESSAGE_DAYS, JSON.stringify(patch.messageRetentionDays));
      }
      if (patch.storageLimitBytes !== undefined) {
        writeSetting(sqlite, KEY_STORAGE_LIMIT, JSON.stringify(patch.storageLimitBytes));
      }
      if (patch.storageTargetBytes !== undefined) {
        writeSetting(sqlite, KEY_STORAGE_TARGET, JSON.stringify(patch.storageTargetBytes));
      }
      return getRetention();
    },

    updateBridge(patch) {
      if (patch.token !== undefined) {
        writeSetting(sqlite, KEY_DISCORD_TOKEN, JSON.stringify(patch.token === '' ? null : patch.token));
      }
      if (patch.enabled !== undefined) {
        writeSetting(sqlite, KEY_BRIDGE_ENABLED, JSON.stringify(patch.enabled));
      }
      return getBridgePublic();
    },
  };
}
