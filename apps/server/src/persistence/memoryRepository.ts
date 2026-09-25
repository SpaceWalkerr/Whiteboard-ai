import type {
  BoardRepository,
  BuildSnapshot,
  CompactionResult,
  LoadedBoard,
  NewUpdate,
  StoredUpdate,
} from "./repository";

interface MemoryBoard {
  deleted: boolean;
  lastSeq: number;
  snapshots: { seqUpto: number; state: Uint8Array }[];
  updates: StoredUpdate[];
  archive: StoredUpdate[];
}

/** In-memory BoardRepository for fast tests. `failNext` simulates database outages. */
export class MemoryBoardRepository implements BoardRepository {
  readonly boards = new Map<string, MemoryBoard>();
  failNext = 0;
  appendCalls = 0;

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated database outage");
    }
  }

  load(boardId: string): Promise<LoadedBoard> {
    this.maybeFail();
    const board = this.boards.get(boardId);
    if (!board)
      return Promise.resolve({
        exists: false,
        deleted: false,
        snapshot: null,
        updates: [],
        maxSeq: 0,
      });
    const snapshot = board.snapshots.at(-1) ?? null;
    const after = snapshot?.seqUpto ?? 0;
    const updates = board.updates.filter((u) => u.seq > after);
    return Promise.resolve({
      exists: true,
      deleted: board.deleted,
      snapshot,
      updates,
      maxSeq: Math.max(after, updates.at(-1)?.seq ?? 0),
    });
  }

  append(
    boardId: string,
    updates: readonly NewUpdate[],
  ): Promise<{ firstSeq: number; lastSeq: number }> {
    this.appendCalls += 1;
    this.maybeFail();
    if (updates.length === 0) return Promise.resolve({ firstSeq: 0, lastSeq: 0 });
    const board = this.boards.get(boardId) ?? {
      deleted: false,
      lastSeq: 0,
      snapshots: [],
      updates: [],
      archive: [],
    };
    const firstSeq = board.lastSeq + 1;
    board.updates.push(...updates.map((u, i) => ({ ...u, seq: firstSeq + i })));
    board.lastSeq += updates.length;
    this.boards.set(boardId, board);
    return Promise.resolve({ firstSeq, lastSeq: board.lastSeq });
  }

  compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null> {
    this.maybeFail();
    const board = this.boards.get(boardId);
    if (!board) return Promise.resolve(null);
    const snapshot = board.snapshots.at(-1) ?? null;
    const updates = board.updates.filter((u) => u.seq > (snapshot?.seqUpto ?? 0));
    const last = updates.at(-1);
    if (!last) return Promise.resolve(null);
    board.snapshots.push({
      seqUpto: last.seq,
      state: build(
        snapshot?.state ?? null,
        updates.map((u) => u.update),
      ),
    });
    board.archive.push(...board.updates.filter((u) => u.seq <= last.seq));
    board.updates = board.updates.filter((u) => u.seq > last.seq);
    return Promise.resolve({ seqUpto: last.seq, compacted: updates.length });
  }
}
