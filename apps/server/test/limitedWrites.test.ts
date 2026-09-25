import { describe, expect, it } from "vitest";
import { LimitedWritesRepository } from "../src/persistence/limitedWrites";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import type { BoardRepository } from "../src/persistence/repository";
import { buildSnapshot } from "../src/sync/roomPersistence";

/** A repository whose writes take a while, recording how many overlap. */
class SlowRepository extends MemoryBoardRepository {
  concurrent = 0;
  maxConcurrent = 0;

  override async append(...args: Parameters<BoardRepository["append"]>) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await super.append(...args);
    } finally {
      this.concurrent -= 1;
    }
  }
}

const update = { update: new Uint8Array([0, 0]), clientId: null, userId: null };

describe("LimitedWritesRepository", () => {
  it("never runs more writes at once than allowed, and runs them all", async () => {
    const inner = new SlowRepository();
    const limited = new LimitedWritesRepository(inner, 3);
    const boards = Array.from({ length: 5 }, () => crypto.randomUUID());
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => limited.append(boards[i % 5] ?? "", [update])),
    );
    expect(inner.maxConcurrent).toBe(3);
    expect(limited.inFlight).toBe(0);
    for (const board of boards) expect(inner.boards.get(board)?.updates).toHaveLength(8);
  });

  it("releases the slot when a write fails, and never limits reads", async () => {
    const inner = new MemoryBoardRepository();
    const limited = new LimitedWritesRepository(inner, 1);
    inner.failNext = 1;
    await expect(limited.append("board", [update])).rejects.toThrow("simulated");
    await limited.append("board", [update]);
    await limited.compact("board", buildSnapshot);
    expect(limited.inFlight).toBe(0);
    // Reads go straight through even while every write slot is taken.
    const blocked = limited.append("board", [update]);
    await expect(limited.load("board")).resolves.toMatchObject({ exists: true });
    await blocked;
  });
});
