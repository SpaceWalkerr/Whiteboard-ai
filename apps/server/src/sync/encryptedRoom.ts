import { createHash, randomInt } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Logger } from "pino";
import {
  encodeEncryptedState,
  encodePeerLeft,
  encodeServerAwareness,
  encodeServerUpdate,
  encodeSnapshotRequest,
  encodeWelcome,
  encodeMessage,
  isEnvelope,
  MESSAGE_PERSISTED,
} from "@whiteboard/shared/sync";
import {
  CLUSTER_KINDS,
  clusterKindName,
  type ClusterKind,
  type ClusterMessage,
} from "../cluster/envelope";
import type { RoomBus } from "../cluster/roomBus";
import type { BoardRepository, LoadedBoard, NewUpdate } from "../persistence/repository";
import type { SyncMetrics } from "./metrics";
import type { PersistedContent, RoomPersistence } from "./roomPersistence";
import {
  encodeVector,
  mergeStateVectors,
  type ManagedRoom,
  type RoomLoad,
  type RoomMember,
} from "./roomTypes";

/** A private room's connection, as the room sees it. */
export interface CipherPeer extends RoomMember {
  /** Random per connection; names this connection's presence and update counters. */
  readonly peerId: number;
  /** Editors and owners may write (and are asked for snapshots); viewers only read. */
  readonly canWrite: boolean;
}

/** An update counter a client attached to its update ("n-th update on this connection"). */
interface Ack {
  peer: number;
  n: number;
}

interface CipherEntry {
  blob: Uint8Array;
  hash: string;
  ack: Ack | null;
  /** Its board_updates seq once committed (null while pending or not written by us). */
  seq: number | null;
}

/** Presence older than this is not sent to newcomers (clients renew theirs every 15 s). */
const PRESENCE_STALE_MS = 30_000;
/** How long a client has to answer a snapshot request. */
const SNAPSHOT_TIMEOUT_MS = 30_000;
const HASH_BYTES = 8;

function hashOf(blob: Uint8Array): string {
  return createHash("sha256").update(blob).digest().subarray(0, HASH_BYTES).toString("hex");
}

function encodeEntries(entries: readonly { blob: Uint8Array; ack: Ack | null }[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { blob, ack } of entries) {
    encoding.writeVarUint(encoder, ack?.peer ?? 0);
    encoding.writeVarUint(encoder, ack?.n ?? 0);
    encoding.writeVarUint8Array(encoder, blob);
  }
  return encoding.toUint8Array(encoder);
}

function decodeEntries(payload: Uint8Array): { blob: Uint8Array; ack: Ack | null }[] {
  const decoder = decoding.createDecoder(payload);
  const count = decoding.readVarUint(decoder);
  const entries: { blob: Uint8Array; ack: Ack | null }[] = [];
  for (let i = 0; i < count; i++) {
    const peer = decoding.readVarUint(decoder);
    const n = decoding.readVarUint(decoder);
    const blob = decoding.readVarUint8Array(decoder);
    if (!isEnvelope(blob)) throw new Error("not an envelope");
    entries.push({ blob, ack: peer === 0 ? null : { peer, n } });
  }
  return entries;
}

/**
 * The content of a private room: the latest encrypted snapshot and the encrypted updates
 * after it, all opaque. Entries are identified by a hash of their bytes (every envelope has
 * a random IV, so equal bytes mean the same message), which makes relays idempotent and lets
 * a new writer find exactly what the database lacks.
 */
export class CipherLog implements PersistedContent {
  snapshot: { seqUpto: number; blob: Uint8Array } | null = null;
  entries: CipherEntry[] = [];
  /** Every hash ever seen, including entries folded into a snapshot since. */
  private readonly known = new Set<string>();
  /** Highest counter seen per peer: what "persisted" means once everything is committed. */
  private readonly acks = new Map<number, number>();
  /** Highest seq known to be committed. */
  lastCommittedSeq = 0;

  constructor(
    private readonly repository: BoardRepository,
    private readonly boardId: string,
    private readonly onCompact: () => void,
  ) {}

  load(loaded: LoadedBoard): void {
    this.snapshot = loaded.snapshot
      ? { seqUpto: loaded.snapshot.seqUpto, blob: loaded.snapshot.state }
      : null;
    for (const u of loaded.updates) this.add(u.update, null, u.seq);
    this.lastCommittedSeq = loaded.maxSeq;
  }

  has(hash: string): boolean {
    return this.known.has(hash);
  }

  /** Adds an entry; null when it is already known (a duplicate relay). */
  add(blob: Uint8Array, ack: Ack | null, seq: number | null = null): CipherEntry | null {
    const hash = hashOf(blob);
    if (this.known.has(hash)) return null;
    this.known.add(hash);
    const entry: CipherEntry = { blob, hash, ack, seq };
    this.entries.push(entry);
    if (ack && ack.n > (this.acks.get(ack.peer) ?? 0)) this.acks.set(ack.peer, ack.n);
    if (seq !== null) this.lastCommittedSeq = Math.max(this.lastCommittedSeq, seq);
    return entry;
  }

  knownHashes(): Uint8Array {
    const out = new Uint8Array(this.known.size * HASH_BYTES);
    let offset = 0;
    for (const hash of this.known) {
      out.set(Buffer.from(hash, "hex"), offset);
      offset += HASH_BYTES;
    }
    return out;
  }

  /** A client-made snapshot covering every update up to `seqUpto` was stored. */
  installSnapshot(seqUpto: number, blob: Uint8Array): void {
    this.snapshot = { seqUpto, blob };
    this.entries = this.entries.filter((e) => e.seq === null || e.seq > seqUpto);
  }

  durableMarker(): Uint8Array {
    return encodeVector(this.acks);
  }

  async catchUp() {
    const stored = await this.repository.load(this.boardId);
    // Everything stored after the snapshot our log starts from (live or already archived).
    const rows = await this.repository.updatesSince(this.boardId, this.snapshot?.seqUpto ?? 0);
    const storedSeq = new Map(rows.map((row) => [hashOf(row.update), row.seq]));
    const missing: NewUpdate[] = [];
    for (const entry of this.entries) {
      const seq = storedSeq.get(entry.hash);
      if (seq !== undefined) entry.seq = seq;
      else if (entry.seq === null) missing.push(this.toNewUpdate(entry));
    }
    return { missing, storedSinceSnapshot: stored.updates.length };
  }

  fullState(): NewUpdate[] {
    return this.entries.filter((e) => e.seq === null).map((e) => this.toNewUpdate(e));
  }

  committed(batch: readonly NewUpdate[], firstSeq: number): void {
    const bySeq = new Map(this.entries.map((e) => [e.blob, e]));
    batch.forEach((update, i) => {
      const entry = bySeq.get(update.update);
      if (entry) entry.seq = firstSeq + i;
    });
    this.lastCommittedSeq = Math.max(this.lastCommittedSeq, firstSeq + batch.length - 1);
  }

  compact(): Promise<boolean> {
    // The server can't merge ciphertext: ask a client (answered later, outside the queue).
    this.onCompact();
    return Promise.resolve(false);
  }

  private toNewUpdate(entry: CipherEntry): NewUpdate {
    // Same Uint8Array object as the entry, so `committed` can find it.
    return { update: entry.blob, clientId: null, userId: null };
  }
}

export interface EncryptedRoomOptions {
  bus: RoomBus;
  metrics: SyncMetrics;
  logger: Logger;
  repository: BoardRepository;
}

interface Presence {
  blob: Uint8Array;
  /** The local connection it belongs to, or null for a client of another instance. */
  member: CipherPeer | null;
  at: number;
}

/**
 * A private board's room on this instance. It relays and stores envelopes it can't read:
 * no Yjs, no presence parsing. Durability, leases and cross-instance relaying work like a
 * normal room (see Room), with these differences:
 *
 * - Clients get the stored board as snapshot + updates (MESSAGE_ENC_STATE) and send back
 *   what the server lacks; "persisted" is a peer → counter vector.
 * - Compaction: the writer asks one synced editor on this instance for an encrypted
 *   snapshot covering the last committed seq, after making sure (from the database) that
 *   every stored update up to it has been sent to that client.
 * - Presence: the last envelope per peer, relayed with the peer id; when a connection
 *   closes everyone is told its peer left (clients drop that peer's cursors).
 */
export class EncryptedRoom implements ManagedRoom {
  readonly members = new Set<RoomMember>();
  private readonly peers = new Map<RoomMember, CipherPeer>();
  readonly log: CipherLog;
  /** Presence envelopes by peer id (local and other instances' clients). */
  private readonly presence = new Map<number, Presence>();
  evictTimer: NodeJS.Timeout | null = null;
  persistence: RoomPersistence | null = null;
  closing = false;
  holdsLease = false;
  leaseBusy = false;
  persistedVector: Uint8Array = encodeVector(new Map());
  ready: Promise<RoomLoad> = Promise.resolve({ ok: true });
  private queuedCluster: ClusterMessage[] | null = [];
  private snapshotRequest: {
    id: number;
    seqUpto: number;
    peer: CipherPeer;
    timer: NodeJS.Timeout;
  } | null = null;
  private snapshotStarting = false;

  constructor(
    readonly boardId: string,
    private readonly options: EncryptedRoomOptions,
  ) {
    this.log = new CipherLog(options.repository, boardId, () => {
      void this.requestSnapshot();
    });
  }

  get loaded(): boolean {
    return this.queuedCluster === null;
  }

  isClosing(): boolean {
    return this.closing;
  }

  applyLoaded(loaded: LoadedBoard): void {
    this.log.load(loaded);
  }

  createContent(): CipherLog {
    return this.log;
  }

  addMember(member: RoomMember): void {
    this.members.add(member);
  }

  /**
   * A connection is ready: send it who it is, the stored board, presence and "persisted".
   * From now on it has everything in the log (and gets every new entry), so it may be
   * asked for snapshots.
   */
  welcome(peer: CipherPeer): void {
    this.peers.set(peer, peer);
    peer.send(encodeWelcome(peer.peerId));
    peer.send(
      encodeEncryptedState({
        snapshot: this.log.snapshot?.blob ?? null,
        updates: this.log.entries.map((e) => e.blob),
      }),
    );
    const now = Date.now();
    for (const [peerId, p] of this.presence) {
      if (p.member !== peer && now - p.at < PRESENCE_STALE_MS)
        peer.send(encodeServerAwareness(peerId, p.blob));
    }
    peer.send(this.persistedMessage());
  }

  /** An encrypted update from a local client (write access already checked). */
  receiveUpdate(peer: CipherPeer, n: number, blob: Uint8Array): void {
    const ack = { peer: peer.peerId, n };
    const entry = this.log.add(blob, ack);
    if (!entry) return;
    this.broadcast(encodeServerUpdate(blob), peer);
    this.persistence?.enqueue(blob, peer.attribution());
    this.publish(CLUSTER_KINDS.update, encodeEntries([{ blob, ack }]));
  }

  receiveAwareness(peer: CipherPeer, blob: Uint8Array): void {
    this.presence.set(peer.peerId, { blob, member: peer, at: Date.now() });
    this.broadcast(encodeServerAwareness(peer.peerId, blob), peer);
    this.publish(CLUSTER_KINDS.awareness, this.encodePresence(peer.peerId, blob));
  }

  /**
   * A client's answer to a snapshot request. Accepted only from the connection that was
   * asked, for the request it was asked; returns false otherwise (the caller counts it).
   */
  async receiveSnapshot(peer: CipherPeer, requestId: number, blob: Uint8Array): Promise<boolean> {
    const request = this.snapshotRequest;
    if (request?.peer !== peer || request.id !== requestId) return false;
    clearTimeout(request.timer);
    this.snapshotRequest = null;
    try {
      const archived = await this.options.repository.installSnapshot(
        this.boardId,
        request.seqUpto,
        blob,
      );
      if (archived === null) return true; // Superseded (e.g. another writer got there first).
      this.log.installSnapshot(request.seqUpto, blob);
      this.persistence?.snapshotInstalled(archived);
      this.options.logger.debug(
        { boardId: this.boardId, seqUpto: request.seqUpto, archived },
        "installed client snapshot",
      );
    } catch (error) {
      // Like compaction, only an optimisation: the updates are still stored.
      this.options.logger.error({ err: error, boardId: this.boardId }, "snapshot install failed");
    }
    return true;
  }

  removeMember(member: RoomMember): void {
    const peer = this.peers.get(member);
    this.peers.delete(member);
    this.members.delete(member);
    if (!peer) return;
    if (this.snapshotRequest?.peer === peer) {
      clearTimeout(this.snapshotRequest.timer);
      this.snapshotRequest = null;
    }
    this.presence.delete(peer.peerId);
    this.broadcast(encodePeerLeft(peer.peerId), null);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, peer.peerId);
    this.publish(CLUSTER_KINDS.peerLeft, encoding.toUint8Array(encoder));
  }

  persistedMessage(): Uint8Array {
    return encodeMessage(MESSAGE_PERSISTED, (encoder) => {
      encoding.writeVarUint8Array(encoder, this.persistedVector);
    });
  }

  markPersisted(marker: Uint8Array, announce: boolean): void {
    this.persistedVector = mergeStateVectors(this.persistedVector, marker);
    this.broadcast(this.persistedMessage(), null);
    if (announce) this.publish(CLUSTER_KINDS.persisted, marker);
  }

  finishLoading(): void {
    const queued = this.queuedCluster ?? [];
    this.queuedCluster = null;
    for (const message of queued) this.handleCluster(message);
    this.requestSync();
    this.publish(CLUSTER_KINDS.awarenessRequest, new Uint8Array());
  }

  /** Tells the other instances which entries we have; they send what we lack. */
  requestSync(): void {
    this.publish(CLUSTER_KINDS.syncRequest, this.log.knownHashes());
  }

  handleCluster(message: ClusterMessage): void {
    if (this.queuedCluster) {
      this.queuedCluster.push(message);
      return;
    }
    try {
      this.applyCluster(message);
    } catch {
      this.options.metrics.clusterDropped.inc({ reason: "malformed" });
    }
  }

  private applyCluster(message: ClusterMessage): void {
    switch (message.kind) {
      case CLUSTER_KINDS.update:
      case CLUSTER_KINDS.syncReply:
        for (const { blob, ack } of decodeEntries(message.payload)) {
          if (!this.log.add(blob, ack)) continue;
          this.broadcast(encodeServerUpdate(blob), null);
          this.persistence?.enqueue(blob, { clientId: null, userId: null });
        }
        return;
      case CLUSTER_KINDS.syncRequest:
        this.answerSyncRequest(message.from, message.payload);
        return;
      case CLUSTER_KINDS.awareness: {
        const decoder = decoding.createDecoder(message.payload);
        const peerId = decoding.readVarUint(decoder);
        const blob = decoding.readVarUint8Array(decoder);
        if (!isEnvelope(blob)) throw new Error("not an envelope");
        const existing = this.presence.get(peerId);
        if (existing?.member) {
          // Peer ids are random per connection; one of ours can't also be elsewhere.
          this.options.metrics.clusterDropped.inc({ reason: "awareness_conflict" });
          return;
        }
        this.presence.set(peerId, { blob, member: null, at: Date.now() });
        this.broadcast(encodeServerAwareness(peerId, blob), null);
        return;
      }
      case CLUSTER_KINDS.peerLeft: {
        const peerId = decoding.readVarUint(decoding.createDecoder(message.payload));
        if (this.presence.get(peerId)?.member) return;
        this.presence.delete(peerId);
        this.broadcast(encodePeerLeft(peerId), null);
        return;
      }
      case CLUSTER_KINDS.awarenessRequest:
        for (const [peerId, p] of this.presence) {
          if (p.member) this.publish(CLUSTER_KINDS.awareness, this.encodePresence(peerId, p.blob));
        }
        return;
      case CLUSTER_KINDS.persisted:
        if (!this.persistence?.isActive) this.markPersisted(message.payload, false);
        return;
      case CLUSTER_KINDS.leaseReleased:
        return; // Handled by the RoomManager.
    }
  }

  private answerSyncRequest(from: string, hashes: Uint8Array): void {
    if (hashes.byteLength % HASH_BYTES !== 0) throw new Error("bad hash list");
    const theirs = new Set<string>();
    for (let i = 0; i < hashes.byteLength; i += HASH_BYTES)
      theirs.add(Buffer.from(hashes.subarray(i, i + HASH_BYTES)).toString("hex"));
    const lacking = this.log.entries.filter((e) => !theirs.has(e.hash));
    if (lacking.length > 0) {
      this.options.bus.publish(this.boardId, {
        kind: CLUSTER_KINDS.syncReply,
        payload: encodeEntries(lacking),
        to: from,
      });
      this.options.metrics.clusterMessages.inc({ kind: "syncReply", direction: "out" });
    }
    // If they know something we don't, ask for it too.
    for (const hash of theirs) {
      if (!this.log.has(hash)) {
        this.requestSync();
        return;
      }
    }
  }

  /**
   * Compaction for a private room (writer only). Picks a synced editor on this instance,
   * makes sure every stored update up to the last committed seq has been sent to it (adding
   * any stored update this instance never saw, e.g. written by a previous writer), then asks
   * it for an encrypted snapshot covering that seq.
   */
  private async requestSnapshot(): Promise<void> {
    if (this.snapshotRequest || this.snapshotStarting || this.closing) return;
    const seqUpto = this.log.lastCommittedSeq;
    const covered = this.log.snapshot?.seqUpto ?? 0;
    if (seqUpto <= covered || !this.pickSnapshotPeer()) return;
    this.snapshotStarting = true;
    try {
      const stored = await this.options.repository.updatesSince(this.boardId, covered);
      for (const row of stored) {
        if (row.seq > seqUpto || !isEnvelope(row.update)) continue;
        // Already committed: relay to our clients, but don't store it again.
        if (this.log.add(row.update, null, row.seq))
          this.broadcast(encodeServerUpdate(row.update), null);
      }
      const peer = this.pickSnapshotPeer();
      if (!peer || this.isClosing()) return;
      const id = randomInt(1, 2 ** 31);
      const timer = setTimeout(() => {
        if (this.snapshotRequest?.id === id) this.snapshotRequest = null;
      }, SNAPSHOT_TIMEOUT_MS);
      timer.unref();
      this.snapshotRequest = { id, seqUpto, peer, timer };
      peer.send(encodeSnapshotRequest(id, seqUpto));
    } catch (error) {
      this.options.logger.warn({ err: error, boardId: this.boardId }, "snapshot request failed");
    } finally {
      this.snapshotStarting = false;
    }
  }

  private pickSnapshotPeer(): CipherPeer | null {
    for (const peer of this.peers.values()) if (peer.canWrite) return peer;
    return null;
  }

  private encodePresence(peerId: number, blob: Uint8Array): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, peerId);
    encoding.writeVarUint8Array(encoder, blob);
    return encoding.toUint8Array(encoder);
  }

  private publish(kind: ClusterKind, payload: Uint8Array): void {
    this.options.bus.publish(this.boardId, { kind, payload });
    this.options.metrics.clusterMessages.inc({ kind: clusterKindName(kind), direction: "out" });
  }

  private broadcast(message: Uint8Array, except: RoomMember | null): void {
    for (const member of this.members) {
      if (member !== except) member.send(message);
    }
  }

  destroy(): void {
    if (this.evictTimer) clearTimeout(this.evictTimer);
    if (this.snapshotRequest) clearTimeout(this.snapshotRequest.timer);
    this.snapshotRequest = null;
    this.persistence?.dispose();
    this.presence.clear();
  }
}
