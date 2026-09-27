import * as decoding from "lib0/decoding";
import {
  isEnvelope,
  MESSAGE_ENC_AWARENESS,
  MESSAGE_ENC_SNAPSHOT,
  MESSAGE_ENC_UPDATE,
  randomPeerId,
} from "@whiteboard/shared/sync";
import { can } from "../access/boardAccess";
import { RoomConnection } from "./connection";
import type { CipherPeer, EncryptedRoom } from "./encryptedRoom";
import type { Attribution } from "./roomPersistence";

/** Presence envelopes are small; anything bigger than this is not presence. */
const MAX_AWARENESS_ENVELOPE = 16 * 1024;

/**
 * A private board's connection. Accepts only the encrypted protocol (plain Yjs messages
 * close the socket with 1007), checks each envelope's shape and the sender's role, and
 * never looks inside: that is what makes the room end-to-end encrypted.
 */
export class EncryptedConnection extends RoomConnection<EncryptedRoom> implements CipherPeer {
  readonly peerId = randomPeerId() || 1;
  /** Highest update counter received: counters must increase (they drive "Saved"). */
  private lastCounter = 0;

  get canWrite(): boolean {
    return can(this.identity.role, "write");
  }

  override attribution(): Attribution {
    return { clientId: null, userId: this.identity.userId };
  }

  protected override beginSync(): void {
    this.room.welcome(this);
  }

  protected override handleType(type: number, decoder: decoding.Decoder, bytes: number): void {
    const { metrics } = this.options;
    switch (type) {
      case MESSAGE_ENC_UPDATE: {
        const n = decoding.readVarUint(decoder);
        const envelope = decoding.readVarUint8Array(decoder);
        this.expectEnd(decoder, envelope);
        metrics.messages.inc({ type: "enc_update" });
        if (!this.canWrite) {
          metrics.messages.inc({ type: "write_denied" });
          return;
        }
        if (n <= this.lastCounter) throw new Error("update counter must increase");
        this.lastCounter = n;
        metrics.updateBytes.inc(bytes);
        this.room.receiveUpdate(this, n, envelope);
        return;
      }
      case MESSAGE_ENC_AWARENESS: {
        const envelope = decoding.readVarUint8Array(decoder);
        this.expectEnd(decoder, envelope);
        if (envelope.byteLength > MAX_AWARENESS_ENVELOPE) throw new Error("presence too large");
        metrics.messages.inc({ type: "enc_awareness" });
        this.room.receiveAwareness(this, envelope);
        return;
      }
      case MESSAGE_ENC_SNAPSHOT: {
        const requestId = decoding.readVarUint(decoder);
        const envelope = decoding.readVarUint8Array(decoder);
        this.expectEnd(decoder, envelope);
        metrics.messages.inc({ type: "enc_snapshot" });
        if (!this.canWrite) {
          metrics.messages.inc({ type: "write_denied" });
          return;
        }
        void this.room.receiveSnapshot(this, requestId, envelope).then((accepted) => {
          if (!accepted) metrics.messages.inc({ type: "enc_snapshot_unsolicited" });
        });
        return;
      }
      default:
        // Includes plain y-protocols sync/awareness: never accepted in a private room.
        throw new Error(`unexpected message type ${String(type)} in a private room`);
    }
  }

  private expectEnd(decoder: decoding.Decoder, envelope: Uint8Array): void {
    if (decoding.hasContent(decoder) || !isEnvelope(envelope))
      throw new Error("malformed encrypted message");
  }
}
