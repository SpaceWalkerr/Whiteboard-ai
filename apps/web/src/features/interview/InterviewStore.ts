import {
  isNewerState,
  publicInterviewStateSchema,
  type InterviewQuestion,
  type InterviewRole,
  type InterviewView,
  type PublicInterviewState,
} from "@whiteboard/shared/interview";

export interface InterviewSnapshot {
  /** The board's current (or last) interview, as everyone in the room sees it. */
  state: PublicInterviewState | null;
  /** My role, from the participant list; null = not a participant. */
  myRole: InterviewRole | null;
  /** The full question with hints — only ever loaded for interviewers. */
  question: InterviewQuestion | null;
  /** Server clock minus local clock (ms), so every participant sees the same countdown. */
  clockOffset: number;
}

const EMPTY: InterviewSnapshot = { state: null, myRole: null, question: null, clockOffset: 0 };

/**
 * The board's interview for this session. Public state arrives over the board's WebSocket
 * (the server pushes it on join and on every change); the interviewer-only question is
 * fetched over REST, and only when my role is interviewer.
 */
export class InterviewStore {
  private snapshot: InterviewSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private questionFor: string | null = null;

  constructor(
    private readonly userId: string,
    private readonly loadView: () => Promise<InterviewView | null>,
    private readonly now: () => number = Date.now,
  ) {}

  get = (): InterviewSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Server time now (epoch ms). */
  serverNow(): number {
    return this.now() + this.snapshot.clockOffset;
  }

  /** A state pushed over the socket (untrusted JSON until validated). */
  receive = (raw: unknown): void => {
    const parsed = publicInterviewStateSchema.safeParse(raw);
    if (parsed.success) this.applyState(parsed.data);
  };

  /** A view returned by a REST call (initial load, or after my own action). */
  applyView(view: InterviewView | null): void {
    if (view === null) return;
    if (view.question) this.questionFor = view.state.interviewId;
    this.applyState(view.state);
    const current = this.snapshot;
    if (
      view.question &&
      current.state?.interviewId === view.state.interviewId &&
      current.myRole === "interviewer"
    )
      this.set({ question: view.question });
  }

  async refresh(): Promise<void> {
    this.applyView(await this.loadView());
  }

  private applyState(state: PublicInterviewState): void {
    if (!isNewerState(this.snapshot.state, state)) return;
    const myRole = state.participants.find((p) => p.userId === this.userId)?.role ?? null;
    const changedInterview = this.snapshot.state?.interviewId !== state.interviewId;
    this.set({
      state,
      myRole,
      clockOffset: state.serverNow - this.now(),
      question: changedInterview || myRole !== "interviewer" ? null : this.snapshot.question,
    });
    // Became an interviewer (or a new interview started): fetch the question with hints.
    if (myRole === "interviewer" && this.questionFor !== state.interviewId) {
      this.questionFor = state.interviewId;
      void this.refresh().catch(() => {
        this.questionFor = null;
      });
    }
    if (myRole !== "interviewer") this.questionFor = null;
  }

  private set(patch: Partial<InterviewSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
