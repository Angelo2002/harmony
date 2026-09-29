import type { DatabaseSync } from 'node:sqlite';
import { readAllSettings, writeSetting } from '../db/settings.ts';

export interface ServerSettings {
  serverName: string;
  requireInvite: boolean;
}

export interface SettingsService {
  get(): ServerSettings;
  update(patch: Partial<ServerSettings>): ServerSettings;
}

const KEY_SERVER_NAME = 'server_name';
const KEY_REQUIRE_INVITE = 'require_invite';

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

  return {
    get,

    update(patch) {
      if (patch.serverName !== undefined) writeSetting(sqlite, KEY_SERVER_NAME, JSON.stringify(patch.serverName));
      if (patch.requireInvite !== undefined) {
        writeSetting(sqlite, KEY_REQUIRE_INVITE, JSON.stringify(patch.requireInvite));
      }
      return get();
    },
  };
}
