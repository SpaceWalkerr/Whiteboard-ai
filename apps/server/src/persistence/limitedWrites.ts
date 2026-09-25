import type {
  BoardRepository,
  BuildSnapshot,
  CompactionResult,
  LoadedBoard,
  NewUpdate,
} from "./repository";

/**
 * Caps how many persistence writes (appends, compactions) run at once, leaving the rest of
 * the connection pool to latency-critical reads: socket authorization and room loads. Under
 * load, writes then queue here and each room's next batch simply grows (fewer, larger
 * transactions), instead of every connection being busy writing while a user waits 30 s
 * for their board to open (found by the 2,000-connection load test).
 */
export class LimitedWritesRepository implements BoardRepository {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly inner: BoardRepository,
    private readonly maxConcurrentWrites: number,
  ) {}

  get inFlight(): number {
    return this.running;
  }

  load(boardId: string): Promise<LoadedBoard> {
    return this.inner.load(boardId);
  }

  append(boardId: string, updates: readonly NewUpdate[]) {
    return this.limited(() => this.inner.append(boardId, updates));
  }

  compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null> {
    return this.limited(() => this.inner.compact(boardId, build));
  }

  private async limited<T>(write: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrentWrites) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await write();
    } finally {
      // Hand the slot straight to the next waiter (running stays the same), or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
