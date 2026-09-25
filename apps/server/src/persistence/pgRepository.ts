import {
  and,
  asc,
  boards,
  boardSnapshots,
  boardUpdateArchive,
  boardUpdates,
  desc,
  eq,
  gt,
  lte,
  sql,
  type Database,
} from "@whiteboard/shared/db";
import type {
  BoardRepository,
  BuildSnapshot,
  CompactionResult,
  LoadedBoard,
  StoredUpdate,
} from "./repository";

export class PgBoardRepository implements BoardRepository {
  constructor(private readonly db: Database) {}

  async load(boardId: string): Promise<LoadedBoard> {
    const [board] = await this.db
      .select({ deletedAt: boards.deletedAt })
      .from(boards)
      .where(eq(boards.id, boardId));
    if (!board) return { exists: false, deleted: false, snapshot: null, updates: [], maxSeq: 0 };

    const [snapshot] = await this.db
      .select({ seqUpto: boardSnapshots.seqUpto, state: boardSnapshots.state })
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, boardId))
      .orderBy(desc(boardSnapshots.seqUpto))
      .limit(1);
    const after = snapshot?.seqUpto ?? 0;
    const updates = await this.db
      .select({
        seq: boardUpdates.seq,
        update: boardUpdates.update,
        clientId: boardUpdates.clientId,
        userId: boardUpdates.userId,
      })
      .from(boardUpdates)
      .where(and(eq(boardUpdates.boardId, boardId), gt(boardUpdates.seq, after)))
      .orderBy(asc(boardUpdates.seq));

    return {
      exists: true,
      deleted: board.deletedAt !== null,
      snapshot: snapshot ?? null,
      updates,
      maxSeq: Math.max(after, updates.at(-1)?.seq ?? 0),
    };
  }

  async append(boardId: string, updates: readonly StoredUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(boards)
        .values({ id: boardId })
        .onConflictDoUpdate({ target: boards.id, set: { updatedAt: sql`now()` } });
      await tx.insert(boardUpdates).values(updates.map((u) => ({ boardId, ...u })));
    });
  }

  async compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null> {
    return this.db.transaction(async (tx) => {
      // Lock the board row so two compactions of one board (e.g. two instances in Phase 5)
      // never interleave.
      const [locked] = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(eq(boards.id, boardId))
        .for("update");
      if (!locked) return null;

      const [snapshot] = await tx
        .select({ seqUpto: boardSnapshots.seqUpto, state: boardSnapshots.state })
        .from(boardSnapshots)
        .where(eq(boardSnapshots.boardId, boardId))
        .orderBy(desc(boardSnapshots.seqUpto))
        .limit(1);
      const after = snapshot?.seqUpto ?? 0;
      const updates = await tx
        .select({ seq: boardUpdates.seq, update: boardUpdates.update })
        .from(boardUpdates)
        .where(and(eq(boardUpdates.boardId, boardId), gt(boardUpdates.seq, after)))
        .orderBy(asc(boardUpdates.seq));
      const last = updates.at(-1);
      if (!last) return null;

      const state = build(
        snapshot?.state ?? null,
        updates.map((u) => u.update),
      );
      await tx.insert(boardSnapshots).values({ boardId, seqUpto: last.seq, state });
      const range = and(eq(boardUpdates.boardId, boardId), lte(boardUpdates.seq, last.seq));
      await tx.insert(boardUpdateArchive).select(
        tx
          .select({
            boardId: boardUpdates.boardId,
            seq: boardUpdates.seq,
            update: boardUpdates.update,
            clientId: boardUpdates.clientId,
            userId: boardUpdates.userId,
            createdAt: boardUpdates.createdAt,
          })
          .from(boardUpdates)
          .where(range),
      );
      await tx.delete(boardUpdates).where(range);
      return { seqUpto: last.seq, compacted: updates.length };
    });
  }
}
