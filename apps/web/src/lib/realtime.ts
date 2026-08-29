/**
 * Realtime client (blueprint 08/16).
 *
 * Reconnects with capped exponential backoff and jitter, replays its subscriptions on
 * reconnect, and reports connection state so modules can show an honest "reconnecting"
 * indicator instead of pretending to be live. The database stays authoritative: frames
 * trigger reconciliation, they are not treated as the source of truth.
 */
import { API_URL } from './api';
import { isDesktop } from './desktop';
import { currentAccessToken } from './tokens';

export type RealtimeFrame = {
  channel: string;
  type: string;
  data: Record<string, unknown>;
  at?: string;
};

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

type Listener = (frame: RealtimeFrame) => void;

class RealtimeClient {
  private socket: WebSocket | null = null;
  private readonly channels = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = 'closed';
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private shouldRun = false;

  connect(): void {
    this.shouldRun = true;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const url = `${API_URL.replace(/^http/, 'ws')}/api/v1/ws`;
    let socket: WebSocket;
    try {
      /**
       * A WebSocket cannot carry an Authorization header - neither a browser nor Electron
       * will set one - so the desktop client passes its token as a subprotocol instead.
       * That keeps the credential out of the URL, and therefore out of access logs, proxy
       * logs and history, where it would outlive the session it belongs to.
       *
       * The web build sends nothing extra: its cookie travels with the handshake.
       */
      const token = isDesktop ? currentAccessToken() : null;
      socket = token ? new WebSocket(url, ['bearer', token]) : new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      // Re-subscribe: the server authorizes each channel again, so a permission that
      // was revoked while disconnected is not silently restored.
      for (const channel of this.channels) {
        socket.send(JSON.stringify({ action: 'subscribe', channel }));
      }
    };

    socket.onmessage = (event) => {
      let frame: RealtimeFrame;
      try {
        frame = JSON.parse(String(event.data)) as RealtimeFrame;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(frame);
    };

    socket.onclose = (event) => {
      this.socket = null;
      // 4401 means the session is gone; reconnecting would loop pointlessly.
      if (event.code === 4401 || !this.shouldRun) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; backoff is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    this.setState('reconnecting');
    this.attempt += 1;
    // Capped backoff with jitter so a restarting server is not stampeded.
    const base = Math.min(30_000, 2 ** Math.min(this.attempt, 5) * 500);
    const delay = base / 2 + Math.random() * (base / 2);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.channels.clear();
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  subscribe(channel: string): () => void {
    this.channels.add(channel);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ action: 'subscribe', channel }));
    }
    return () => {
      this.channels.delete(channel);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ action: 'unsubscribe', channel }));
      }
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

export const realtime = new RealtimeClient();
