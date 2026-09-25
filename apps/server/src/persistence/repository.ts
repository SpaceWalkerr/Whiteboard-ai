/** The board row no longer exists (purged); its pending updates can never be stored. */
export class BoardMissingError extends Error {
  constructor(boardId: string) {
    super(`board ${boardId} does not exist`);
    this.name = "BoardMissingError";
  }
}

export interface StoredUpdate {
  seq: number;
  update: Uint8Array;
  clientId: number | null;
  userId: string | null;
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
  /** Appends updates (creating the board row on first save) in one transaction. */
  append(boardId: string, updates: readonly StoredUpdate[]): Promise<void>;
  /**
   * Folds all updates since the latest snapshot into a new snapshot and moves them to the
   * archive, in one transaction. Returns null when there is nothing to compact.
   */
  compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null>;
}
