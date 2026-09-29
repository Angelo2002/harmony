import {
  GatewayEvent,
  GatewayOp,
  type GatewayEventName,
  type PresenceUpdatePayload,
  type User,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';

interface Client {
  send: (payload: string) => void;
  disconnect: (code: number, reason: string) => void;
  auth: AuthContext | null;
}

/**
 * In-process registry of connected gateway clients, used to fan out dispatch
 * events and to end a specific member's connections. One instance means no need
 * for Redis or any cross-process bus.
 *
 * Presence falls out of this registry: a member is online while they hold at
 * least one authenticated connection. Nothing about it is stored, so a restart
 * simply starts everyone offline again.
 */
export class GatewayHub {
  #clients = new Map<number, Client>();
  #nextId = 1;
  /** How many live connections each member holds. */
  #onlineCounts = new Map<string, number>();

  /** Registers a freshly connected (but not yet identified) client. */
  register(send: (payload: string) => void, disconnect: (code: number, reason: string) => void): number {
    const id = this.#nextId++;
    this.#clients.set(id, { send, disconnect, auth: null });
    return id;
  }

  /**
   * Marks a client as authenticated after a successful IDENTIFY, announcing the
   * member coming online if this is their first connection. A repeated IDENTIFY
   * on an already-identified socket is ignored, so the count cannot drift.
   */
  authenticate(id: number, auth: AuthContext): void {
    const client = this.#clients.get(id);
    if (!client || client.auth) return;

    client.auth = auth;
    const userId = auth.user.id;
    const count = this.#onlineCounts.get(userId) ?? 0;
    this.#onlineCounts.set(userId, count + 1);
    if (count === 0) this.#announcePresence(auth.user, true);
  }

  unregister(id: number): void {
    const client = this.#clients.get(id);
    this.#clients.delete(id);
    if (!client?.auth) return;

    const userId = client.auth.user.id;
    const remaining = (this.#onlineCounts.get(userId) ?? 1) - 1;
    if (remaining > 0) {
      this.#onlineCounts.set(userId, remaining);
      return;
    }

    this.#onlineCounts.delete(userId);
    this.#announcePresence(client.auth.user, false);
  }

  /** The ids of every member with at least one live connection. */
  onlineUserIds(): Set<string> {
    return new Set(this.#onlineCounts.keys());
  }

  /**
   * Closes every connection belonging to one user, used when they are kicked or
   * banned. The client sees the close code and drops to the login screen.
   */
  disconnectUser(userId: string, code: number, reason: string): void {
    for (const client of this.#clients.values()) {
      if (client.auth?.user.id !== userId) continue;
      try {
        client.disconnect(code, reason);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }

  /** Sends a dispatch event to every authenticated client. */
  dispatch(event: GatewayEventName, payload: unknown): void {
    const frame = JSON.stringify({ op: GatewayOp.Dispatch, t: event, d: payload });
    for (const client of this.#clients.values()) {
      if (!client.auth) continue;
      try {
        client.send(frame);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }

  #announcePresence(user: User, online: boolean): void {
    const payload: PresenceUpdatePayload = { user, online };
    this.dispatch(GatewayEvent.PresenceUpdate, payload);
  }
}
