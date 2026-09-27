import { backoffDelay, type BackoffOptions } from "./backoff";
import {
  CLOSE_CODES,
  MAX_SERVER_MESSAGE_BYTES,
  roomPath,
  SYNC_SUBPROTOCOL,
  TICKET_PROTOCOL_PREFIX,
  toUint8Array,
} from "./protocol";

/** "denied" = no (longer any) access to this board; the provider stops reconnecting. */
export type SyncStatus = "connecting" | "connected" | "reconnecting" | "offline" | "denied";

/** `bad_key`: a private board's data can't be decrypted with the key we were given. */
export type DeniedReason = "unauthorized" | "forbidden" | "not_found" | "bad_key";

/** Result of asking the API for a room ticket before (re)connecting. */
export type TicketResult =
  { ok: true; ticket: string } | { ok: false; reason: Exclude<DeniedReason, "bad_key"> | "error" };

/** "saved" once the server confirms every edit in this document is committed to its database. */
export type SaveState = "saved" | "saving";

/** The subset of the browser WebSocket API the provider uses (the `ws` package matches it). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Online/offline signal (the browser's navigator.onLine + events); absent in Node. */
export interface NetworkSignal {
  isOnline(): boolean;
  subscribe(onChange: (online: boolean) => void): () => void;
}

export interface RoomSocketOptions {
  /** Base URL of the sync server, e.g. wss://api.example.com */
  serverUrl: string;
  boardId: string;
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /**
   * Fetches a fresh room ticket before every connection attempt (so every reconnect re-checks
   * access). Omitted only in tests against a server without authorization.
   */
  getTicket?: () => Promise<TicketResult>;
  network?: NetworkSignal | null;
  backoff?: BackoffOptions;
  random?: () => number;
}

const OPEN = 1;

/**
 * The transport half of a sync provider: one WebSocket to /rooms/:boardId, fetched tickets,
 * reconnects with exponential backoff, online/offline handling, status and access denial.
 * Subclasses speak a protocol over it (plain Yjs, or the encrypted protocol of private rooms).
 */
export abstract class RoomSocket {
  private status: SyncStatus = "connecting";
  private readonly listeners = new Set<() => void>();
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected destroyed = false;
  protected hasConnected = false;
  private unsubscribeNetwork: () => void = () => undefined;
  private readonly createSocket: (url: string, protocols: string[]) => WebSocketLike;
  private deniedReason: DeniedReason | null = null;
  private connecting = false;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;

  constructor(private readonly socketOptions: RoomSocketOptions) {
    this.createSocket =
      socketOptions.createSocket ??
      ((url, protocols) => new globalThis.WebSocket(url, protocols) as unknown as WebSocketLike);
    this.backoff = socketOptions.backoff ?? { initialMs: 500, maxMs: 30_000 };
    this.random = socketOptions.random ?? Math.random;
  }

  /** Call at the end of the subclass constructor (after its own fields are set up). */
  protected start(): void {
    const network = this.socketOptions.network;
    this.unsubscribeNetwork = network
      ? network.subscribe((online) => {
          if (online) this.reconnectNow();
          else this.goOffline();
        })
      : () => undefined;
    if (network && !network.isOnline()) this.setStatus("offline");
    else this.connect();
  }

  getStatus = (): SyncStatus => this.status;

  /** Why access was denied (when status is "denied"). */
  getDeniedReason = (): DeniedReason | null => this.deniedReason;

  abstract getSaveState(): SaveState;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnect();
    this.unsubscribeNetwork();
    this.onDestroy();
    this.closeSocket();
    this.listeners.clear();
  }

  /** Drops the connection and reconnects immediately (e.g. the browser came back online). */
  reconnectNow(): void {
    if (this.destroyed || this.status === "denied") return;
    this.clearReconnect();
    this.closeSocket();
    this.attempt = 0;
    this.connect();
  }

  /** The socket just opened (status is "connected"). */
  protected abstract onOpen(): void;
  /** A binary message from the server (size already checked). */
  protected abstract onMessage(message: Uint8Array): void;
  /** The socket went away (closed, dropped or replaced). */
  protected abstract onDisconnected(): void;
  /** Last chance to send something before the socket is closed for good. */
  protected abstract onDestroy(): void;

  protected isConnected(): boolean {
    return this.status === "connected";
  }

  protected sendNow(message: Uint8Array): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) return;
    try {
      socket.send(message);
    } catch {
      this.reconnectNow();
    }
  }

  /** Stops for good with the given reason (the UI explains it). */
  protected deny(reason: DeniedReason): void {
    this.clearReconnect();
    this.deniedReason = reason;
    this.setStatus("denied");
    if (reason === "bad_key") this.closeSocket();
  }

  protected notify(): void {
    for (const listener of this.listeners) listener();
  }

  private connect(): void {
    if (this.destroyed || this.connecting || this.status === "denied") return;
    this.setStatus(this.hasConnected ? "reconnecting" : "connecting");
    this.connecting = true;
    void this.openSocket().finally(() => {
      this.connecting = false;
    });
  }

  private async openSocket(): Promise<void> {
    const protocols = [SYNC_SUBPROTOCOL];
    if (this.socketOptions.getTicket) {
      let result: TicketResult;
      try {
        result = await this.socketOptions.getTicket();
      } catch {
        result = { ok: false, reason: "error" };
      }
      if (this.destroyed || this.status === "offline" || this.status === "denied") return;
      if (!result.ok) {
        if (result.reason === "error") this.scheduleReconnect();
        else this.deny(result.reason);
        return;
      }
      protocols.push(`${TICKET_PROTOCOL_PREFIX}${result.ticket}`);
    }
    const url = `${this.socketOptions.serverUrl.replace(/\/$/, "")}${roomPath(this.socketOptions.boardId)}`;
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(url, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.hasConnected = true;
      this.setStatus("connected");
      this.onOpen();
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      const data = event.data;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
      const message = toUint8Array(data);
      if (message.byteLength > MAX_SERVER_MESSAGE_BYTES) return;
      this.onMessage(message);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.onDisconnected();
      if (this.destroyed || this.status === "offline" || this.status === "denied") return;
      if (event.code === CLOSE_CODES.boardDeleted) {
        this.deny("not_found");
      } else if (event.code === CLOSE_CODES.accessChanged) {
        // Our access changed: reconnect right away with a fresh ticket (which re-checks it).
        this.attempt = 0;
        this.setStatus("reconnecting");
        this.connect();
      } else {
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
  }

  private goOffline(): void {
    this.clearReconnect();
    this.setStatus("offline");
    this.closeSocket();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setStatus(this.hasConnected ? "reconnecting" : "connecting");
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    this.onDisconnected();
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.notify();
  }
}
