import { GatewayOp, type GatewayEventName } from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';

interface Client {
  send: (payload: string) => void;
  auth: AuthContext | null;
}

/**
 * In-process registry of connected gateway clients, used to fan out dispatch
 * events. One instance means no need for Redis or any cross-process bus.
 */
export class GatewayHub {
  #clients = new Map<number, Client>();
  #nextId = 1;

  /** Registers a freshly connected (but not yet identified) client. */
  register(send: (payload: string) => void): number {
    const id = this.#nextId++;
    this.#clients.set(id, { send, auth: null });
    return id;
  }

  /** Marks a client as authenticated after a successful IDENTIFY. */
  authenticate(id: number, auth: AuthContext): void {
    const client = this.#clients.get(id);
    if (client) client.auth = auth;
  }

  unregister(id: number): void {
    this.#clients.delete(id);
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
}
