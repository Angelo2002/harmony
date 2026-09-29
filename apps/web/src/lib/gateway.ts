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
      this.#socket = null;
      this.#emit({ op: -1, t: 'CLOSE', d: { code: event.code } });
      // 4004 means the session was rejected — retrying would just loop.
      if (!this.#stopped && event.code !== 4004) this.#scheduleReconnect();
    });
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
