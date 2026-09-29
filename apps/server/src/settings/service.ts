import type { DatabaseSync } from 'node:sqlite';
import type { RetentionSettings } from '@harmony/shared';
import { readAllSettings, writeSetting } from '../db/settings.ts';

export interface ServerSettings {
  serverName: string;
  requireInvite: boolean;
  /** Channel opened by default on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: boolean;
}

export interface BridgeSettings {
  /** Bot token, or null when the bridge has never been configured. */
  token: string | null;
  enabled: boolean;
  /**
   * Publicly reachable base URL of this instance, used to hand Discord image
   * URLs. Null disables outbound avatars.
   */
  publicBaseUrl: string | null;
}

/** Bridge settings safe to hand to the client: never includes the token. */
export interface BridgePublicSettings {
  configured: boolean;
  enabled: boolean;
  publicBaseUrl: string | null;
}

export interface SettingsService {
  get(): ServerSettings;
  update(patch: Partial<ServerSettings>): ServerSettings;
  getRetention(): RetentionSettings;
  updateRetention(patch: Partial<RetentionSettings>): RetentionSettings;
  getBridge(): BridgeSettings;
  getBridgePublic(): BridgePublicSettings;
  updateBridge(patch: { token?: string; enabled?: boolean; publicBaseUrl?: string | null }): BridgePublicSettings;
}

const KEY_SERVER_NAME = 'server_name';
const KEY_REQUIRE_INVITE = 'require_invite';
const KEY_DEFAULT_CHANNEL = 'default_channel_id';
const KEY_EMBEDS_ENABLED = 'embeds_enabled';
const KEY_IMAGE_DAYS = 'retention_image_days';
const KEY_MESSAGE_DAYS = 'retention_message_days';
const KEY_STORAGE_LIMIT = 'storage_limit_bytes';
const KEY_STORAGE_TARGET = 'storage_target_bytes';
const KEY_DISCORD_TOKEN = 'discord_bot_token';
const KEY_BRIDGE_ENABLED = 'bridge_enabled';
const KEY_BRIDGE_PUBLIC_URL = 'bridge_public_base_url';

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
    const embeds = stored.get(KEY_EMBEDS_ENABLED);

    return {
      serverName: name ? parseString(name, defaults.serverName) : defaults.serverName,
      requireInvite: requireInvite ? parseBoolean(requireInvite, defaults.requireInvite) : defaults.requireInvite,
      defaultChannelId: parseStringOrNull(stored.get(KEY_DEFAULT_CHANNEL)),
      embedsEnabled: embeds ? parseBoolean(embeds, defaults.embedsEnabled) : defaults.embedsEnabled,
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
      publicBaseUrl: parseStringOrNull(stored.get(KEY_BRIDGE_PUBLIC_URL)),
    };
  }

  function getBridgePublic(): BridgePublicSettings {
    const bridge = getBridge();
    return {
      configured: bridge.token !== null,
      enabled: bridge.enabled,
      publicBaseUrl: bridge.publicBaseUrl,
    };
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
      if (patch.defaultChannelId !== undefined) {
        writeSetting(sqlite, KEY_DEFAULT_CHANNEL, JSON.stringify(patch.defaultChannelId));
      }
      if (patch.embedsEnabled !== undefined) {
        writeSetting(sqlite, KEY_EMBEDS_ENABLED, JSON.stringify(patch.embedsEnabled));
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
      if (patch.publicBaseUrl !== undefined) {
        const trimmed = patch.publicBaseUrl?.trim() ?? '';
        writeSetting(sqlite, KEY_BRIDGE_PUBLIC_URL, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      return getBridgePublic();
    },
  };
}
