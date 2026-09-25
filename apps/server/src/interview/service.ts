import {
  interviewQuestionSchema,
  type InterviewQuestion,
  type InterviewRole,
  type InterviewTimer,
  type Participant,
  type PublicInterviewState,
} from "@whiteboard/shared/interview";
import {
  and,
  desc,
  eq,
  interviewParticipants,
  interviews,
  profiles,
  sql,
  type Database,
} from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";

export type InterviewRow = typeof interviews.$inferSelect;

export async function findInterview(
  db: Database | Tx,
  interviewId: string,
): Promise<InterviewRow | undefined> {
  const [row] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
  return row;
}

/** The board's current interview: the active one, else the most recent one. */
export async function latestInterview(
  db: Database | Tx,
  boardId: string,
): Promise<InterviewRow | undefined> {
  const [row] = await db
    .select()
    .from(interviews)
    .where(eq(interviews.boardId, boardId))
    .orderBy(sql`(${interviews.status} = 'active') desc`, desc(interviews.startedAt))
    .limit(1);
  return row;
}

/** The caller's role in an interview, or null when they are not a participant. */
export async function interviewRoleOf(
  db: Database | Tx,
  interviewId: string,
  userId: string | null,
): Promise<InterviewRole | null> {
  if (userId === null) return null;
  const [row] = await db
    .select({ role: interviewParticipants.role })
    .from(interviewParticipants)
    .where(
      and(
        eq(interviewParticipants.interviewId, interviewId),
        eq(interviewParticipants.userId, userId),
      ),
    );
  return row?.role ?? null;
}

export async function participantsOf(
  db: Database | Tx,
  interviewId: string,
): Promise<Participant[]> {
  const rows = await db
    .select({
      userId: interviewParticipants.userId,
      role: interviewParticipants.role,
      name: profiles.displayName,
      email: profiles.email,
    })
    .from(interviewParticipants)
    .leftJoin(profiles, eq(profiles.id, interviewParticipants.userId))
    .where(eq(interviewParticipants.interviewId, interviewId))
    .orderBy(interviewParticipants.createdAt);
  const order: Record<InterviewRole, number> = { interviewer: 0, candidate: 1, observer: 2 };
  return rows
    .map((r) => ({ userId: r.userId, role: r.role, name: r.name ?? r.email ?? "Unknown user" }))
    .sort((a, b) => order[a.role] - order[b.role]);
}

/** The stored question snapshot (validated on the way out, like everything we store). */
export function questionOf(row: InterviewRow): InterviewQuestion {
  return interviewQuestionSchema.parse(row.question);
}

export function timerOf(row: InterviewRow): InterviewTimer {
  return {
    durationMs: row.durationMs,
    startedAt: row.startedAt.getTime(),
    pausedAt: row.pausedAt?.getTime() ?? null,
    pausedMs: row.pausedMs,
    endedAt: row.endedAt?.getTime() ?? null,
  };
}

/**
 * What every socket in the room receives. Built field by field from public data only — the
 * question's hints are included only once revealed, and nothing else private (notes,
 * scorecards, reviews) is read here at all.
 */
export function toPublicState(
  row: InterviewRow,
  participants: Participant[],
): PublicInterviewState {
  const question = questionOf(row);
  return {
    interviewId: row.id,
    boardId: row.boardId,
    version: row.version,
    status: row.status,
    question: {
      id: question.id,
      title: question.title,
      prompt: question.prompt,
      requirements: question.requirements,
    },
    revealedHints: [...new Set(row.revealedHints)]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const text = question.hints[index];
        return text === undefined ? [] : [{ index, text }];
      }),
    timer: timerOf(row),
    participants,
    serverNow: Date.now(),
  };
}

/** Public state of the board's current interview, or null when it never had one. */
export async function loadPublicState(
  db: Database,
  boardId: string,
): Promise<PublicInterviewState | null> {
  const row = await latestInterview(db, boardId);
  if (!row) return null;
  return toPublicState(row, await participantsOf(db, row.id));
}
