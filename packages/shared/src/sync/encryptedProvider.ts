import * as decoding from "lib0/decoding";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { decryptBytes, DecryptionError, encryptBytes, type RoomKey } from "./e2e";
import {
  encodeClientAwareness,
  encodeClientUpdate,
  encodeSnapshotReply,
  MESSAGE_ENC_AWARENESS,
  MESSAGE_ENC_PEER_LEFT,
  MESSAGE_ENC_SNAPSHOT_REQUEST,
  MESSAGE_ENC_STATE,
  MESSAGE_ENC_UPDATE,
  MESSAGE_ENC_WELCOME,
  readEncryptedState,
} from "./encryptedProtocol";
import { missingFrom } from "./missing";
import { MESSAGE_PERSISTED, readAwarenessEntries } from "./protocol";
import { RoomSocket, type RoomSocketOptions, type SaveState } from "./socketBase";

export interface EncryptedSyncProviderOptions extends RoomSocketOptions {
  doc: Y.Doc;
  awareness: Awareness;
  roomKey: RoomKey;
  /** Schedules a flush of batched outgoing updates (requestAnimationFrame in browsers). */
  scheduleFlush?: (flush: () => void) => void;
}

/**
 * Connects a Y.Doc and its Awareness to a private (end-to-end encrypted) room. Everything
 * leaves this class encrypted with the room key and everything that arrives is decrypted
 * and validated here; the server only ever sees envelopes.
 *
 * - On (re)connect the server sends the stored board (encrypted snapshot + updates). We
 *   apply it and send back exactly what the server lacks (offline edits, deletions
 *   included), computed against a copy of what it sent.
 * - Live local updates are merged per frame, encrypted and sent with a per-connection
 *   counter; the server's "persisted" vector says which counter is durable ("Saved").
 * - Messages are handled strictly in arrival order (decryption is asynchronous), which is
 *   what makes the server's snapshot requests safe: when one arrives, every update it
 *   covers has already been applied here.
 * - Presence client ids are bound to the peer (connection) that first sent them, so one
 *   key holder can't move or remove someone else's cursor.
 */
export class EncryptedSyncProvider extends RoomSocket {
  private saveState: SaveState = "saved";
  private readonly scheduleFlush: (flush: () => void) => void;
  /** Bumped whenever the connection goes away; async work of an old connection is dropped. */
  private generation = 0;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private peerId: number | null = null;
  /** The stored board has been received and applied on this connection. */
  private synced = false;
  /** Last update counter used on this connection, and the highest one the server stored. */
  private counter = 0;
  private persistedCounter = 0;
  /** Local edits not sent on this connection (the next sync's diff carries them). */
  private unsent = false;
  private pending: Uint8Array[] = [];
  private flushScheduled = false;
  /** Batches being encrypted/sent. */
  private inflight = 0;
  /** Messages skipped because they couldn't be decrypted (see tryDecrypt). */
  undecryptable = 0;
  /** Presence client id → the peer that owns it. */
  private readonly owners = new Map<number, number>();

  constructor(private readonly options: EncryptedSyncProviderOptions) {
    super(options);
    this.scheduleFlush =
      options.scheduleFlush ??
      ((flush) => {
        setTimeout(flush, 16);
      });
    // Content we already hold (e.g. offline edits) isn't known to be stored until we sync.
    this.unsent = options.doc.store.clients.size > 0;
    this.recomputeSaveState();
    options.doc.on("update", this.handleDocUpdate);
    options.awareness.on("update", this.handleAwarenessUpdate);
    this.start();
  }

  getSaveState(): SaveState {
    return this.saveState;
  }

  protected override onDestroy(): void {
    this.options.doc.off("update", this.handleDocUpdate);
    this.options.awareness.off("update", this.handleAwarenessUpdate);
    // No goodbye message: the server tells everyone this peer left when the socket closes.
  }

  protected override onOpen(): void {
    if (this.options.awareness.getLocalState() !== null)
      this.sendAwareness([this.options.doc.clientID]);
  }

  protected override onDisconnected(): void {
    this.generation += 1;
    // Anything not confirmed on this connection is re-sent by the next sync's diff.
    if (
      this.pending.length > 0 ||
      this.inflight > 0 ||
      this.counter > this.persistedCounter ||
      (!this.synced && this.unsent)
    )
      this.unsent = true;
    this.pending = [];
    this.peerId = null;
    this.synced = false;
    this.counter = 0;
    this.persistedCounter = 0;
    this.owners.clear();
    const { awareness, doc } = this.options;
    const remote = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID);
    if (remote.length > 0) removeAwarenessStates(awareness, remote, this);
    this.recomputeSaveState();
  }

  protected override onMessage(message: Uint8Array): void {
    const generation = this.generation;
    this.inbound = this.inbound
      .then(() => (generation === this.generation ? this.handle(message) : undefined))
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        if (error instanceof DecryptionError) this.deny("bad_key");
        else this.reconnectNow(); // Malformed message: resync from scratch.
      });
  }

  private async handle(message: Uint8Array): Promise<void> {
    const { doc, awareness, roomKey } = this.options;
    const generation = this.generation;
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_ENC_WELCOME:
        this.peerId = decoding.readVarUint(decoder);
        return;
      case MESSAGE_ENC_STATE: {
        const state = readEncryptedState(decoder);
        const snapshot = state.snapshot
          ? await decryptBytes(roomKey, "snapshot", state.snapshot)
          : null;
        const updates: Uint8Array[] = [];
        for (const update of state.updates) {
          const plain = await this.tryDecrypt("update", update);
          if (plain) updates.push(plain);
        }
        // Nothing at all decrypts: the key is wrong (a verified key never gets here).
        if (updates.length === 0 && state.updates.length > 0) throw new DecryptionError();
        if (generation !== this.generation) return;
        Y.transact(
          doc,
          () => {
            if (snapshot) Y.applyUpdate(doc, snapshot, this);
            for (const update of updates) Y.applyUpdate(doc, update, this);
          },
          this,
        );
        const missing = missingFrom(snapshot, updates, Y.encodeStateAsUpdate(doc));
        this.synced = true;
        this.unsent = false;
        if (missing.length > 0) this.sendUpdate(Y.mergeUpdates(missing));
        this.recomputeSaveState();
        return;
      }
      case MESSAGE_ENC_UPDATE: {
        const update = await this.tryDecrypt("update", decoding.readVarUint8Array(decoder));
        if (update && generation === this.generation) Y.applyUpdate(doc, update, this);
        return;
      }
      case MESSAGE_ENC_AWARENESS: {
        const peer = decoding.readVarUint(decoder);
        const update = await this.tryDecrypt("awareness", decoding.readVarUint8Array(decoder));
        if (!update || generation !== this.generation) return;
        const entries = readAwarenessEntries(update);
        if (!entries) return;
        const claimsOthers = entries.some(({ clientId }) => {
          const owner = this.owners.get(clientId);
          return clientId === doc.clientID || (owner !== undefined && owner !== peer);
        });
        if (claimsOthers) return;
        for (const { clientId } of entries) this.owners.set(clientId, peer);
        applyAwarenessUpdate(awareness, update, this);
        return;
      }
      case MESSAGE_ENC_PEER_LEFT: {
        const peer = decoding.readVarUint(decoder);
        const gone = [...this.owners].filter(([, owner]) => owner === peer).map(([id]) => id);
        for (const id of gone) this.owners.delete(id);
        if (gone.length > 0) removeAwarenessStates(awareness, gone, this);
        return;
      }
      case MESSAGE_PERSISTED: {
        const vector = Y.decodeStateVector(decoding.readVarUint8Array(decoder));
        if (this.peerId !== null) this.persistedCounter = vector.get(this.peerId) ?? 0;
        this.recomputeSaveState();
        return;
      }
      case MESSAGE_ENC_SNAPSHOT_REQUEST: {
        const requestId = decoding.readVarUint(decoder);
        decoding.readVarUint(decoder); // seqUpto: the server tracks what it covers
        if (!this.synced) return;
        // Captured now, in message order: it includes everything the request covers.
        const state = Y.encodeStateAsUpdate(doc);
        this.enqueueSend(
          () => encryptBytes(roomKey, "snapshot", state),
          (envelope) => encodeSnapshotReply(requestId, envelope),
        );
        return;
      }
      default:
        throw new Error(`unexpected message ${String(type)}`);
    }
  }

  /**
   * One undecryptable update or presence message (corrupt, or written by someone with a
   * different key) is skipped and counted rather than locking everyone out of the board.
   * The snapshot is the whole board: failing to decrypt it stops the provider instead.
   */
  private async tryDecrypt(
    kind: "update" | "awareness",
    envelope: Uint8Array,
  ): Promise<Uint8Array | null> {
    try {
      return await decryptBytes(this.options.roomKey, kind, envelope);
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      this.undecryptable += 1;
      return null;
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    if (!this.isConnected() || !this.synced) {
      this.unsent = true;
      this.recomputeSaveState();
      return;
    }
    this.pending.push(update);
    this.recomputeSaveState();
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduleFlush(() => {
      this.flushScheduled = false;
      if (this.pending.length === 0) return;
      const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
      this.pending = [];
      if (merged) this.sendUpdate(merged);
    });
  };

  private readonly handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || !this.isConnected()) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed].filter(
      (id) => id === this.options.doc.clientID,
    );
    if (clients.length > 0) this.sendAwareness(clients);
  };

  private sendAwareness(clients: number[]): void {
    const update = encodeAwarenessUpdate(this.options.awareness, clients);
    this.enqueueSend(
      () => encryptBytes(this.options.roomKey, "awareness", update),
      encodeClientAwareness,
    );
  }

  /** Encrypts and sends one update; counters are assigned in send order. */
  private sendUpdate(update: Uint8Array): void {
    this.inflight += 1;
    this.recomputeSaveState();
    this.enqueueSend(
      () => encryptBytes(this.options.roomKey, "update", update),
      (envelope) => {
        this.counter += 1;
        return encodeClientUpdate(this.counter, envelope);
      },
      () => {
        this.inflight -= 1;
        this.recomputeSaveState();
      },
    );
  }

  /**
   * Outgoing messages are encrypted and sent one at a time, in order. `frame` runs only if
   * the connection is still the one the message was meant for.
   */
  private enqueueSend(
    encrypt: () => Promise<Uint8Array>,
    frame: (envelope: Uint8Array) => Uint8Array,
    done?: () => void,
  ): void {
    const generation = this.generation;
    this.outbound = this.outbound
      .then(async () => {
        if (generation !== this.generation) return;
        const envelope = await encrypt();
        if (generation === this.generation) this.sendNow(frame(envelope));
      })
      .catch(() => {
        if (generation === this.generation) this.reconnectNow();
      })
      .finally(() => {
        done?.();
      });
  }

  private recomputeSaveState(): void {
    const saved =
      !this.unsent &&
      this.pending.length === 0 &&
      this.inflight === 0 &&
      this.persistedCounter >= this.counter;
    const next: SaveState = saved ? "saved" : "saving";
    if (next === this.saveState) return;
    this.saveState = next;
    this.notify();
  }
}
