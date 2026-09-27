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
import {
  encodeAwarenessMessage,
  encodeMessage,
  MESSAGE_AWARENESS,
  MESSAGE_INTERVIEW,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
  readAwarenessEntries,
} from "./protocol";
import { RoomSocket, type RoomSocketOptions, type SaveState } from "./socketBase";

export type {
  DeniedReason,
  NetworkSignal,
  SaveState,
  SyncStatus,
  TicketResult,
  WebSocketLike,
} from "./socketBase";

export interface SyncProviderOptions extends RoomSocketOptions {
  doc: Y.Doc;
  awareness: Awareness;
  /** Schedules a flush of batched outgoing updates (requestAnimationFrame in browsers). */
  scheduleFlush?: (flush: () => void) => void;
  /** Interview state pushed by the server (unvalidated JSON; the caller validates it). */
  onInterviewState?: (state: unknown) => void;
}

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
export class SyncProvider extends RoomSocket {
  private pending: Uint8Array[] = [];
  private flushScheduled = false;
  /** Latest server acknowledgement: what is durable, per Yjs client id. */
  private persisted = new Map<number, number>();
  private saveState: SaveState = "saved";
  private readonly scheduleFlush: (flush: () => void) => void;

  constructor(private readonly options: SyncProviderOptions) {
    super(options);
    this.scheduleFlush =
      options.scheduleFlush ??
      ((flush) => {
        setTimeout(flush, 16);
      });

    options.doc.on("update", this.handleDocUpdate);
    this.recomputeSaveState();
    options.awareness.on("update", this.handleAwarenessUpdate);
    this.start();
  }

  getSaveState(): SaveState {
    return this.saveState;
  }

  protected override onDestroy(): void {
    this.options.doc.off("update", this.handleDocUpdate);
    this.options.awareness.off("update", this.handleAwarenessUpdate);
    // Tell the room we're gone so our cursor disappears immediately.
    this.sendNow(
      encodeAwarenessMessage(
        encodeAwarenessUpdate(this.options.awareness, [this.options.doc.clientID], new Map()),
      ),
    );
  }

  protected override onOpen(): void {
    this.pending = [];
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
  }

  protected override onDisconnected(): void {
    this.dropRemotePresence();
  }

  protected override onMessage(message: Uint8Array): void {
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
      } else if (type === MESSAGE_INTERVIEW) {
        const state: unknown = JSON.parse(decoding.readVarString(decoder));
        this.options.onInterviewState?.(state);
      }
    } catch {
      // A malformed message from the server: resync from scratch.
      this.reconnectNow();
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.recomputeSaveState();
    if (origin === this) return;
    if (!this.isConnected()) return; // Delivered by the sync step on reconnect.
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
    this.notify();
  }
}
