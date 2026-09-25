import * as Y from "yjs";
import { toBase64 } from "@whiteboard/shared/replay";
import {
  boardSnapshots,
  boardUpdateArchive,
  boardUpdates,
  sql,
  type Database,
} from "@whiteboard/shared/db";
import { PayloadTooLargeError } from "../errors";

/** Upper bound on stored updates in one replay (a long, busy interview is a few thousand). */
export const MAX_REPLAY_UPDATES = 100_000;

export interface ReplayHistory {
  /** Board state (Yjs) just before `from`. */
  base: Uint8Array;
  /** Updates stored in [from, to], grouped by the moment they were stored (epoch ms). */
  frames: { t: number; update: Uint8Array }[];
}

interface UpdateRow extends Record<string, unknown> {
  seq: string | number;
  update: Uint8Array;
  /** created_at in epoch ms (computed in SQL: raw timestamps come back as strings). */
  t: string | number;
}

/**
 * A board's edit history over a time window, from the write-ahead log and its archive
 * (Phase 3 keeps every update and every snapshot for exactly this).
 *
 * The base is the nearest snapshot before the window plus the updates between it and the
 * window. Updates stored in the same database batch share one timestamp and are merged into
 * one frame: nobody could observe the board between them, so this loses nothing.
 */
export async function loadReplayHistory(
  db: Database,
  boardId: string,
  from: Date,
  to: Date,
): Promise<ReplayHistory> {
  const history = sql`(
    select seq, update, created_at from ${boardUpdates} where board_id = ${boardId}
    union all
    select seq, update, created_at from ${boardUpdateArchive} where board_id = ${boardId}
  ) h`;
  const columns = sql`seq, update, floor(extract(epoch from created_at) * 1000)::bigint as t`;

  const [first] = await db.execute<{ seq: string | number | null }>(
    sql`select min(seq) as seq from ${history} where created_at >= ${from.toISOString()}::timestamptz`,
  );
  const firstSeq = first?.seq === null || first?.seq === undefined ? null : Number(first.seq);

  const [snapshot] = await db.execute<{ seq_upto: string | number; state: Uint8Array }>(sql`
    select seq_upto, state from ${boardSnapshots}
    where board_id = ${boardId} ${firstSeq === null ? sql`` : sql`and seq_upto < ${firstSeq}`}
    order by seq_upto desc limit 1`);
  const after = snapshot ? Number(snapshot.seq_upto) : 0;

  const baseRows = await db.execute<UpdateRow>(sql`
    select ${columns} from ${history}
    where seq > ${after} ${firstSeq === null ? sql`` : sql`and seq < ${firstSeq}`}
    order by seq`);

  const windowRows =
    firstSeq === null
      ? []
      : await db.execute<UpdateRow>(sql`
          select ${columns} from ${history}
          where seq >= ${firstSeq} and created_at <= ${to.toISOString()}::timestamptz
          order by seq
          limit ${MAX_REPLAY_UPDATES + 1}`);
  if (windowRows.length > MAX_REPLAY_UPDATES)
    throw new PayloadTooLargeError("This session is too long to replay.");

  const doc = new Y.Doc();
  let base: Uint8Array;
  try {
    doc.transact(() => {
      if (snapshot) Y.applyUpdate(doc, bytes(snapshot.state));
      for (const row of baseRows) Y.applyUpdate(doc, bytes(row.update));
    });
    base = Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }

  const frames: ReplayHistory["frames"] = [];
  let pending: Uint8Array[] = [];
  let pendingT = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const [only] = pending;
    frames.push({
      t: pendingT,
      update: pending.length === 1 && only ? only : Y.mergeUpdates(pending),
    });
    pending = [];
  };
  for (const row of windowRows) {
    const t = Number(row.t);
    if (t !== pendingT) flush();
    pendingT = t;
    pending.push(bytes(row.update));
  }
  flush();
  return { base, frames };
}

/** postgres.js returns bytea as a Buffer (a Uint8Array subclass) in raw queries. */
function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function encodeFrames(frames: ReplayHistory["frames"]): { t: number; u: string }[] {
  return frames.map((f) => ({ t: f.t, u: toBase64(f.update) }));
}
