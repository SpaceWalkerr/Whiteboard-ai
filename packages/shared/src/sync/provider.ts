import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { backoffDelay, type BackoffOptions } from "./backoff";
import {
  CLOSE_CODES,
  encodeAwarenessMessage,
  encodeMessage,
  MAX_SERVER_MESSAGE_BYTES,
  MESSAGE_AWARENESS,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
  readAwarenessEntries,
  roomPath,
  SYNC_SUBPROTOCOL,
  TICKET_PROTOCOL_PREFIX,
  toUint8Array,
} from "./protocol";

/** "denied" = no (longer any) access to this board; the provider stops reconnecting. */
export type SyncStatus = "connecting" | "connected" | "reconnecting" | "offline" | "denied";

export type DeniedReason = "unauthorized" | "forbidden" | "not_found";

/** Result of asking the API for a room ticket before (re)connecting. */
export type TicketResult =
  { ok: true; ticket: string } | { ok: false; reason: DeniedReason | "error" };

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

export interface SyncProviderOptions {
  /** Base URL of the sync server, e.g. wss://api.example.com */
  serverUrl: string;
  boardId: string;
  doc: Y.Doc;
  awareness: Awareness;
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /**
   * Fetches a fresh room ticket before every connection attempt (so every reconnect re-checks
   * access). Omitted only in tests against a server without authorization.
   */
  getTicket?: () => Promise<TicketResult>;
  network?: NetworkSignal | null;
  backoff?: BackoffOptions;
  /** Schedules a flush of batched outgoing updates (requestAnimationFrame in browsers). */
  scheduleFlush?: (flush: () => void) => void;
  random?: () => number;
}

const OPEN = 1;

/**
 * Connects a Y.Doc and its Awareness to /rooms/:boardId on the sync server.
 *
 * - Reconnects with exponential backoff; on every (re)connect both sides exchange sync step 1/2,
 *   so edits made while disconnected merge, and a restarted server gets the document back from
 *   its clients.
 * - Local updates made within one frame are merged into one message (a drag is ≤ 60 msgs/s).
 * - Remote updates are applied with this provider as the transaction origin, so per-user undo
 *   (which tracks only the local origin) never reverts other people's edits.
 */
export class SyncProvider {
  private status: SyncStatus = "connecting";
  private readonly listeners = new Set<() => void>();
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private pending: Uint8Array[] = [];
  private flushScheduled = false;
  private hasConnected = false;
  /** Latest server acknowledgement: what is durable, per Yjs client id. */
  private persisted = new Map<number, number>();
  private saveState: SaveState = "saved";
  private readonly unsubscribeNetwork: () => void;
  private readonly createSocket: (url: string, protocols: string[]) => WebSocketLike;
  private deniedReason: DeniedReason | null = null;
  private connecting = false;
  private readonly scheduleFlush: (flush: () => void) => void;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;

  constructor(private readonly options: SyncProviderOptions) {
    this.createSocket =
      options.createSocket ??
      ((url, protocols) => new globalThis.WebSocket(url, protocols) as unknown as WebSocketLike);
    this.scheduleFlush =
      options.scheduleFlush ??
      ((flush) => {
        setTimeout(flush, 16);
      });
    this.backoff = options.backoff ?? { initialMs: 500, maxMs: 30_000 };
    this.random = options.random ?? Math.random;

    options.doc.on("update", this.handleDocUpdate);
    this.recomputeSaveState();
    options.awareness.on("update", this.handleAwarenessUpdate);

    const network = options.network;
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

  getSaveState = (): SaveState => this.saveState;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnect();
    this.unsubscribeNetwork();
    this.options.doc.off("update", this.handleDocUpdate);
    this.options.awareness.off("update", this.handleAwarenessUpdate);
    // Tell the room we're gone so our cursor disappears immediately.
    this.sendNow(
      encodeAwarenessMessage(
        encodeAwarenessUpdate(this.options.awareness, [this.options.doc.clientID], new Map()),
      ),
    );
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
    if (this.options.getTicket) {
      let result: TicketResult;
      try {
        result = await this.options.getTicket();
      } catch {
        result = { ok: false, reason: "error" };
      }
      if (this.destroyed || this.status === "offline") return;
      if (!result.ok) {
        if (result.reason === "error") this.scheduleReconnect();
        else this.deny(result.reason);
        return;
      }
      protocols.push(`${TICKET_PROTOCOL_PREFIX}${result.ticket}`);
    }
    const url = `${this.options.serverUrl.replace(/\/$/, "")}${roomPath(this.options.boardId)}`;
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
      this.pending = [];
      this.setStatus("connected");
      // Ask for what we're missing; the server replies with step 2 and sends its own step 1.
      this.sendNow(
        encodeMessage(MESSAGE_SYNC, (encoder) => {
          syncProtocol.writeSyncStep1(encoder, this.options.doc);
        }),
      );
      if (this.options.awareness.getLocalState() !== null) {
        this.sendNow(
          encodeAwarenessMessage(
            encodeAwarenessUpdate(this.options.awareness, [this.options.doc.clientID]),
          ),
        );
      }
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.dropRemotePresence();
      if (this.destroyed || this.status === "offline") return;
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

  private handleMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const message = toUint8Array(data);
    if (message.byteLength > MAX_SERVER_MESSAGE_BYTES) return;
    try {
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.options.doc, this);
        if (encoding.length(encoder) > 1) this.sendNow(encoding.toUint8Array(encoder));
      } else if (type === MESSAGE_PERSISTED) {
        this.persisted = Y.decodeStateVector(decoding.readVarUint8Array(decoder));
        this.recomputeSaveState();
      } else if (type === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        if (readAwarenessEntries(update) !== null)
          applyAwarenessUpdate(this.options.awareness, update, this);
      }
    } catch {
      // A malformed message from the server: resync from scratch.
      this.reconnectNow();
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.recomputeSaveState();
    if (origin === this) return;
    if (this.status !== "connected") return; // Delivered by the sync step on reconnect.
    this.pending.push(update);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduleFlush(() => {
      this.flushScheduled = false;
      if (this.pending.length === 0) return;
      const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
      this.pending = [];
      if (!merged) return;
      this.sendNow(
        encodeMessage(MESSAGE_SYNC, (encoder) => {
          syncProtocol.writeUpdate(encoder, merged);
        }),
      );
    });
  };

  private readonly handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed].filter(
      (id) => id === this.options.doc.clientID,
    );
    if (clients.length === 0) return;
    this.sendNow(encodeAwarenessMessage(encodeAwarenessUpdate(this.options.awareness, clients)));
  };

  private sendNow(message: Uint8Array): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) return;
    try {
      socket.send(message);
    } catch {
      this.reconnectNow();
    }
  }

  private deny(reason: DeniedReason): void {
    this.clearReconnect();
    this.deniedReason = reason;
    this.setStatus("denied");
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
    this.dropRemotePresence();
  }

  /** While disconnected we can't know who is still there; clear their cursors. */
  private dropRemotePresence(): void {
    const { awareness, doc } = this.options;
    const remote = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID);
    if (remote.length > 0) removeAwarenessStates(awareness, remote, this);
  }

  /** Saved when the server's durable state vector covers everything in our document. */
  private recomputeSaveState(): void {
    const local = Y.decodeStateVector(Y.encodeStateVector(this.options.doc));
    let saved = true;
    for (const [client, clock] of local) {
      if ((this.persisted.get(client) ?? 0) < clock) {
        saved = false;
        break;
      }
    }
    const next: SaveState = saved ? "saved" : "saving";
    if (next === this.saveState) return;
    this.saveState = next;
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
