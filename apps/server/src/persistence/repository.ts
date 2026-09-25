/** The board row no longer exists (purged); its pending updates can never be stored. */
export class BoardMissingError extends Error {
  constructor(boardId: string) {
    super(`board ${boardId} does not exist`);
    this.name = "BoardMissingError";
  }
}

/** An update to store; the repository assigns its seq. */
export interface NewUpdate {
  update: Uint8Array;
  clientId: number | null;
  userId: string | null;
}

export interface StoredUpdate extends NewUpdate {
  seq: number;
}

export interface LoadedBoard {
  /** False when the board has never been saved (a brand-new board). */
  exists: boolean;
  deleted: boolean;
  snapshot: { seqUpto: number; state: Uint8Array } | null;
  /** Updates after the snapshot, in seq order. */
  updates: StoredUpdate[];
  /** Highest seq used so far (0 for a new board). */
  maxSeq: number;
}

/** Merges a snapshot and later updates into one compact document state. */
export type BuildSnapshot = (
  snapshot: Uint8Array | null,
  updates: readonly Uint8Array[],
) => Uint8Array;

export interface CompactionResult {
  seqUpto: number;
  compacted: number;
}

/**
 * Board persistence. Postgres in production (PgBoardRepository); an in-memory double in fast
 * tests. All methods are safe to retry.
 */
export interface BoardRepository {
  load(boardId: string): Promise<LoadedBoard>;
  /**
   * Appends updates in one transaction, in the given order. Seqs are allocated here, from the
   * board row's counter under its row lock, so any number of instances may append to the
   * same board concurrently: each batch gets a contiguous range, and no two batches clash.
   * Returns the seqs used (empty range for no updates).
   */
  append(
    boardId: string,
    updates: readonly NewUpdate[],
  ): Promise<{ firstSeq: number; lastSeq: number }>;
  /**
   * Folds all updates since the latest snapshot into a new snapshot and moves them to the
   * archive, in one transaction. Returns null when there is nothing to compact.
   */
  compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null>;
}
