import { describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  awarenessMessage,
  encodeMapSet,
  findMarkers,
  marker,
  messageType,
  persistedClock,
  presence,
  syncUpdateMessage,
} from "../src/codec";

describe("load-test codec", () => {
  it("produces the same bytes as Yjs for a series of sets of one key", () => {
    const doc = new Y.Doc();
    doc.clientID = 123456789;
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    for (let clock = 0; clock < 5; clock++) {
      const value = marker(7, clock, 1_700_000_000_000 + clock);
      doc.getMap("lt").set("vu-7", value);
      expect(
        encodeMapSet({ clientId: doc.clientID, clock, rootName: "lt", key: "vu-7", value }),
      ).toEqual(updates[clock]);
    }
  });

  it("produces updates another document applies, ending with the last value", () => {
    const receiver = new Y.Doc();
    for (let clock = 0; clock < 20; clock++) {
      Y.applyUpdate(
        receiver,
        encodeMapSet({ clientId: 42, clock, rootName: "lt", key: "k", value: `v${clock}` }),
      );
    }
    expect(receiver.getMap("lt").get("k")).toBe("v19");
    expect(Y.encodeStateVector(receiver)).toEqual(
      (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 42);
        encoding.writeVarUint(e, 20);
        return encoding.toUint8Array(e);
      })(),
    );
  });

  it("wraps updates and awareness in our wire format", () => {
    const update = encodeMapSet({ clientId: 1, clock: 0, rootName: "lt", key: "k", value: "v" });
    const decoder = decoding.createDecoder(syncUpdateMessage(update));
    expect(decoding.readVarUint(decoder)).toBe(0);
    const doc = new Y.Doc();
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
    expect(doc.getMap("lt").get("k")).toBe("v");

    const awareness = new Awareness(new Y.Doc());
    const message = awarenessMessage(99, 3, presence("user-1", "Load 1", 10, 20));
    const reader = decoding.createDecoder(message);
    expect(decoding.readVarUint(reader)).toBe(1);
    applyAwarenessUpdate(awareness, decoding.readVarUint8Array(reader), null);
    expect(awareness.getStates().get(99)).toEqual(presence("user-1", "Load 1", 10, 20));
  });

  it("finds markers in (merged) updates", () => {
    const a = encodeMapSet({
      clientId: 1,
      clock: 0,
      rootName: "lt",
      key: "a",
      value: marker(1, 5, 1000),
    });
    const b = encodeMapSet({
      clientId: 2,
      clock: 0,
      rootName: "lt",
      key: "b",
      value: marker(2, 6, 2000),
    });
    const found = findMarkers(syncUpdateMessage(Y.mergeUpdates([a, b])));
    expect(found.sort((x, y) => x.vu - y.vu)).toEqual([
      { vu: 1, seq: 5, sentAt: 1000 },
      { vu: 2, seq: 6, sentAt: 2000 },
    ]);
  });

  it("reads the committed clock from a persisted message", () => {
    const vector = encoding.createEncoder();
    encoding.writeVarUint(vector, 2);
    encoding.writeVarUint(vector, 5);
    encoding.writeVarUint(vector, 10);
    encoding.writeVarUint(vector, 300_000);
    encoding.writeVarUint(vector, 7);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 2);
    encoding.writeVarUint8Array(message, encoding.toUint8Array(vector));
    const bytes = encoding.toUint8Array(message);
    expect(messageType(bytes)).toBe(2);
    expect(persistedClock(bytes, 300_000)).toBe(7);
    expect(persistedClock(bytes, 5)).toBe(10);
    expect(persistedClock(bytes, 1)).toBe(0);
  });
});
