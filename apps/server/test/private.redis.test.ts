// Private (end-to-end encrypted) rooms across two sync instances sharing a real Redis:
// ciphertext crosses instances, one instance persists, lost messages are repaired, and the
// writer can go away — all without any instance being able to read the board.
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { generateRoomKeyString, importRoomKey, type RoomKey } from "@whiteboard/shared/sync";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import { LossyBus, startCluster, type TestCluster } from "./clusterHelpers";
import { assertOpaque } from "./privateAssertions";
import {
  allowEncryptedConnections,
  connectEncryptedClient,
  sameState,
  waitFor,
  type EncryptedTestClient,
} from "./syncHelpers";

let cluster: TestCluster | null = null;
const clients: EncryptedTestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  await cluster?.stop();
  cluster = null;
});

async function newKey(): Promise<RoomKey> {
  return importRoomKey(crypto.randomUUID(), generateRoomKeyString());
}

function client(instance: { server: { wsUrl: string } }, key: RoomKey): EncryptedTestClient {
  const c = connectEncryptedClient(instance.server.wsUrl, key);
  clients.push(c);
  return c;
}

function put(doc: Y.Doc, id: string, label: string) {
  doc.getMap<unknown>("shapes").set(id, { id, label });
}

function labels(doc: Y.Doc): string[] {
  return Object.values(doc.getMap("shapes").toJSON())
    .map((s) => (s as { label: string }).label)
    .sort();
}

const connected = (c: EncryptedTestClient) => c.provider.getStatus() === "connected";
const saved = (c: EncryptedTestClient) => c.provider.getSaveState() === "saved";

describe("private rooms across instances", () => {
  it("clients on different instances collaborate; one writer stores only ciphertext", async () => {
    const repository = new MemoryBoardRepository();
    cluster = await startCluster(2, { repository, authorize: allowEncryptedConnections });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const key = await newKey();
    const a = client(one, key);
    const b = client(two, key);
    await waitFor(() => connected(a) && connected(b));

    put(a.doc, "s1", "Orders service");
    put(b.doc, "s2", "Orders database");
    await waitFor(() => labels(a.doc).length === 2 && labels(b.doc).length === 2);
    b.doc.getMap("shapes").delete("s1");
    await waitFor(() => labels(a.doc).join() === "Orders database");

    // Presence both ways, and a peer leaving is seen on the other instance.
    a.awareness.setLocalState({
      user: { id: "u-a", name: "Ada", color: "#1d4ed8" },
      cursor: { x: 3, y: 4 },
      selection: [],
      viewport: null,
    });
    await waitFor(() => b.awareness.getStates().has(a.doc.clientID));

    await waitFor(() => saved(a) && saved(b), 5_000);
    const writers = [one, two].filter(
      (i) => i.server.sync.rooms.getEncrypted(key.boardId)?.persistence?.isActive,
    );
    expect(writers).toHaveLength(1);

    clients.splice(clients.indexOf(a), 1);
    a.provider.destroy();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID));

    const stored = repository.boards.get(key.boardId);
    assertOpaque(
      (stored?.updates ?? []).map((u) => u.update),
      ["Orders service", "Orders database", "Ada"],
    );
    // Each update stored once (relays are deduplicated), even though both instances saw all.
    const hashes = new Set(
      (stored?.updates ?? []).map((u) => Buffer.from(u.update).toString("hex")),
    );
    expect(hashes.size).toBe(stored?.updates.length);
  });

  it("repairs lost pub/sub messages with the periodic resync", async () => {
    const lossy: LossyBus[] = [];
    cluster = await startCluster(2, {
      authorize: allowEncryptedConnections,
      resyncMs: 200,
      wrapBus: (inner) => {
        // Only the first instance loses messages.
        if (lossy.length > 0) return inner;
        const wrapped = new LossyBus(inner);
        lossy.push(wrapped);
        return wrapped;
      },
    });
    const [one, two] = cluster.instances;
    const bus = lossy[0];
    if (!one || !two || !bus) throw new Error("cluster");
    const key = await newKey();
    const a = client(one, key);
    const b = client(two, key);
    await waitFor(() => connected(a) && connected(b));
    put(a.doc, "s0", "before");
    await waitFor(() => labels(b.doc).includes("before"));

    bus.dropping = true;
    put(a.doc, "s1", "lost in transit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(labels(b.doc)).not.toContain("lost in transit");
    bus.dropping = false;
    await waitFor(() => labels(b.doc).includes("lost in transit"), 3_000);
    await waitFor(() => saved(a), 5_000);
    expect(sameState(a.doc, b.doc)).toBe(true);
  });

  it("the other instance takes over persistence when the writer shuts down", async () => {
    const repository = new MemoryBoardRepository();
    cluster = await startCluster(2, { repository, authorize: allowEncryptedConnections });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const key = await newKey();
    // The first client makes its instance the writer.
    const a = client(one, key);
    await waitFor(() => connected(a));
    put(a.doc, "s1", "first");
    await waitFor(() => saved(a));
    const b = client(two, key);
    await waitFor(() => connected(b) && labels(b.doc).includes("first"));
    expect(one.server.sync.rooms.getEncrypted(key.boardId)?.persistence?.isActive).toBe(true);

    clients.splice(clients.indexOf(a), 1);
    a.provider.destroy();
    await one.server.stop();
    put(b.doc, "s2", "after handover");
    await waitFor(() => saved(b), 5_000);
    expect(two.server.sync.rooms.getEncrypted(key.boardId)?.persistence?.isActive).toBe(true);

    // What's stored rebuilds the whole board.
    const reader = client(two, key);
    await waitFor(() => labels(reader.doc).join() === "after handover,first");
  });
});
