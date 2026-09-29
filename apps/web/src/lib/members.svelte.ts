import type { User, UserDirectoryResponse } from '@harmony/shared';
import { api } from './api';

/**
 * Everyone on this instance. It is deliberately separate from the admin member
 * list: the client needs it to resolve and autocomplete `@username` mentions,
 * and it carries no roles or permissions.
 */
class MemberDirectory {
  list = $state<User[]>([]);
  #loadedAt = 0;

  /** Username (lower-cased) -> user, for resolving mention tokens. */
  byUsername = $derived(new Map(this.list.map((user) => [user.username.toLowerCase(), user])));

  /** User id -> user, for looking up the author of a mention. */
  byId = $derived(new Map(this.list.map((user) => [user.id, user])));

  async load(): Promise<void> {
    try {
      this.list = (await api<UserDirectoryResponse>('/members/directory')).users;
      this.#loadedAt = Date.now();
    } catch {
      // Not signed in or offline; keep whatever we already have.
    }
  }

  /** Reloads only if the cached directory is older than `maxAgeMs`. */
  async refreshIfStale(maxAgeMs: number): Promise<void> {
    if (Date.now() - this.#loadedAt > maxAgeMs) await this.load();
  }
}

export const members = new MemberDirectory();
