// Realtime client for docs/websockets.md. One socket per logged-in user,
// carrying `type`-tagged JSON events (e.g. `screen.progress`). The backend
// only checks the token at connect time, so reconnects need a fresh one --
// this refreshes before retrying whenever the server closes with 4001
// (missing/expired/malformed token).

import { getAccessToken, refreshAccessToken } from "./api";

export type WsStatus = "idle" | "connecting" | "open" | "closed";

interface RealtimeMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (message: RealtimeMessage) => void;
type StatusHandler = (status: WsStatus) => void;

const STALE_TOKEN_CLOSE_CODE = 4001;
const MAX_RECONNECT_DELAY_MS = 30_000;

class RealtimeConnection {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private statusHandlers = new Set<StatusHandler>();
  private status: WsStatus = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;

  connect(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.open();
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.socket?.close();
    this.socket = null;
    this.setStatus("idle");
  }

  /** Subscribe to one message type (e.g. "screen.progress"). Returns an unsubscribe fn. */
  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private open(): void {
    const token = getAccessToken();
    if (!token) {
      this.scheduleReconnect();
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/user/?token=${encodeURIComponent(token)}`;

    this.setStatus("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
    };

    socket.onmessage = (event) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.type) return;
      this.handlers.get(message.type)?.forEach((handler) => handler(message));
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return; // a newer socket has already replaced this one
      this.socket = null;
      this.setStatus("closed");
      if (!this.shouldRun) return;

      if (event.code === STALE_TOKEN_CLOSE_CODE) {
        this.refreshThenReconnect();
      } else {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private async refreshThenReconnect(): Promise<void> {
    const refreshed = await refreshAccessToken().catch(() => false);
    if (!this.shouldRun) return;
    if (refreshed) {
      this.reconnectAttempt = 0;
      this.open();
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}

/** Singleton — one connection for the whole app, matching "one socket, one user." */
export const realtime = new RealtimeConnection();
