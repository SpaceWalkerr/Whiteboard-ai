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
import {
  BoardMissingError,
  type BoardRepository,
  type BuildSnapshot,
  type CompactionResult,
  type LoadedBoard,
  type NewUpdate,
  type StoredUpdate,
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

  async append(
    boardId: string,
    updates: readonly NewUpdate[],
  ): Promise<{ firstSeq: number; lastSeq: number }> {
    if (updates.length === 0) return { firstSeq: 0, lastSeq: 0 };
    const rows = JSON.stringify(
      updates.map((u) => ({
        u: Buffer.from(u.update).toString("base64"),
        c: u.clientId,
        uid: u.userId,
      })),
    );
    // ONE statement (one round trip, atomic on its own): reserve a contiguous seq range from
    // the board's counter and insert the batch with it. The UPDATE takes the row lock, so
    // concurrent appends from other instances (and compaction, which locks the same row)
    // wait: ranges never overlap and commit in seq order. Boards are created through the API
    // (with an owner); if the row is gone, nothing is inserted.
    const inserted = await this.db.execute<{ seq: string | number }>(sql`
      with reserved as (
        update ${boards}
        set last_seq = last_seq + ${updates.length}, updated_at = now()
        where id = ${boardId}
        returning last_seq
      )
      insert into ${boardUpdates} (board_id, seq, update, client_id, user_id)
      select ${boardId}, reserved.last_seq - ${updates.length} + e.ord,
             decode(e.value ->> 'u', 'base64'), (e.value ->> 'c')::bigint, e.value ->> 'uid'
      from reserved, jsonb_array_elements(${rows}::jsonb) with ordinality as e(value, ord)
      returning seq`);
    const seqs = [...inserted].map((row) => Number(row.seq));
    if (seqs.length === 0) throw new BoardMissingError(boardId);
    return { firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) };
  }

  async compact(boardId: string, build: BuildSnapshot): Promise<CompactionResult | null> {
    return this.db.transaction(async (tx) => {
      // Lock the board row so two compactions of one board (e.g. two instances in Phase 5)
      // never interleave.
      const [locked] = await tx
        .select({ id: boards.id, isPrivate: boards.isPrivate })
        .from(boards)
        .where(eq(boards.id, boardId))
        .for("update");
      // A private board's updates are ciphertext: merging them is impossible (and must never
      // be attempted); its clients upload snapshots instead (installSnapshot).
      if (!locked || locked.isPrivate) return null;

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

  async installSnapshot(
    boardId: string,
    seqUpto: number,
    state: Uint8Array,
  ): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      // Same row lock as appends and compaction: nothing interleaves with the move.
      const [locked] = await tx
        .select({ lastSeq: boards.lastSeq, isPrivate: boards.isPrivate })
        .from(boards)
        .where(eq(boards.id, boardId))
        .for("update");
      if (!locked?.isPrivate || seqUpto > locked.lastSeq) return null;
      const [latest] = await tx
        .select({ seqUpto: boardSnapshots.seqUpto })
        .from(boardSnapshots)
        .where(eq(boardSnapshots.boardId, boardId))
        .orderBy(desc(boardSnapshots.seqUpto))
        .limit(1);
      if (seqUpto <= (latest?.seqUpto ?? 0)) return null;

      await tx.insert(boardSnapshots).values({ boardId, seqUpto, state });
      const range = and(eq(boardUpdates.boardId, boardId), lte(boardUpdates.seq, seqUpto));
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
      const moved = await tx.delete(boardUpdates).where(range).returning({ seq: boardUpdates.seq });
      return moved.length;
    });
  }

  async updatesSince(boardId: string, afterSeq: number): Promise<StoredUpdate[]> {
    const columns = (table: typeof boardUpdates | typeof boardUpdateArchive) => ({
      seq: table.seq,
      update: table.update,
      clientId: table.clientId,
      userId: table.userId,
    });
    // Live rows first, then the archive: a compaction committing in between moves rows from
    // the first to the second, so they're seen twice (deduplicated) rather than not at all.
    const live = await this.db
      .select(columns(boardUpdates))
      .from(boardUpdates)
      .where(and(eq(boardUpdates.boardId, boardId), gt(boardUpdates.seq, afterSeq)));
    const archived = await this.db
      .select(columns(boardUpdateArchive))
      .from(boardUpdateArchive)
      .where(and(eq(boardUpdateArchive.boardId, boardId), gt(boardUpdateArchive.seq, afterSeq)));
    const bySeq = new Map<number, StoredUpdate>();
    for (const row of [...archived, ...live]) bySeq.set(row.seq, row);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
}
