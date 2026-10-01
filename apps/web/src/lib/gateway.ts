export interface GatewayFrame {
  op: number;
  t?: string;
  d?: unknown;
}

type Listener = (frame: GatewayFrame) => void;

/** Minimal reconnecting WebSocket client for the Harmony gateway. */
export class GatewayClient {
  #url: string;
  #socket: WebSocket | null = null;
  #listeners = new Set<Listener>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(url: string) {
    this.#url = url;
  }

  static defaultUrl(): string {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/gateway`;
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    this.#stopped = false;
    if (this.#socket) return;

    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener('message', (event) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(event.data as string) as GatewayFrame;
      } catch {
        return;
      }

      // Answer the handshake; the cookie sent with the handshake authenticates us.
      if (frame.op === 10) {
        socket.send(JSON.stringify({ op: 2, d: {} }));
        return;
      }

      this.#emit(frame);
    });

    socket.addEventListener('close', (event) => {
      // A socket that was already replaced, by ensureConnected below, must not
      // clear the one now in use or schedule a duplicate reconnect.
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#emit({ op: -1, t: 'CLOSE', d: { code: event.code } });
      // 4004 means the session was rejected, 4005 that it was ended by
      // moderation; retrying either would just loop.
      if (!this.#stopped && event.code !== 4004 && event.code !== 4005) this.#scheduleReconnect();
    });
  }

  /**
   * Reconnects if the socket is not currently open. Used when the tab comes back
   * to the foreground: a socket left behind in the background may never report
   * that it died, so waiting for the reconnect delay would leave the client
   * silently dead. Replacing it makes the server see a fresh connection.
   */
  ensureConnected(): void {
    // A closed client was closed on purpose, such as on sign-out; never revive it.
    if (this.#stopped) return;
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    const stale = this.#socket;
    this.#socket = null;
    stale?.close();
    this.connect();
  }

  close(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  #emit(frame: GatewayFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }
}
