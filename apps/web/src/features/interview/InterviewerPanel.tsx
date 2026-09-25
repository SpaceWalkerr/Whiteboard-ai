import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Pause, Play, Plus, Sparkles, Square, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  INTERVIEW_ROLE_NAMES,
  type InterviewNote,
  type InterviewRole,
  type InterviewView,
} from "@whiteboard/shared/interview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { IconButton } from "@/features/board/ui/IconButton";
import type { InterviewApi } from "./api";
import type { InterviewStore } from "./InterviewStore";
import { ScorecardForm } from "./ScorecardForm";
import type { Person } from "./StartInterviewDialog";

const TABS = ["question", "notes", "scorecard", "people"] as const;
type Tab = (typeof TABS)[number];
const TAB_NAMES: Record<Tab, string> = {
  question: "Question",
  notes: "Notes",
  scorecard: "Scorecard",
  people: "People",
};

interface InterviewerPanelProps {
  interview: InterviewStore;
  api: InterviewApi;
  me: Person;
  /** Signed-in people on the board right now (for role changes). */
  people: Person[];
  onClose: () => void;
  /** Opens the AI review dialog with the question as the problem statement. */
  onRunReview: () => void;
  onEnded: (interviewId: string) => void;
}

/**
 * Interviewers only: hints to reveal, private notes, the scorecard, roles, timer controls
 * and ending the interview. Everything here is loaded over REST routes that refuse anyone
 * who is not an interviewer — nothing of it is ever in the board document or on the socket.
 */
export function InterviewerPanel({
  interview,
  api,
  me,
  people,
  onClose,
  onRunReview,
  onEnded,
}: InterviewerPanelProps) {
  const { state, question } = useSyncExternalStore(interview.subscribe, interview.get);
  const [tab, setTab] = useState<Tab>("question");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  if (!state) return null;
  const id = state.interviewId;
  const paused = state.timer.pausedAt !== null;

  /** Runs an interviewer action; the returned view updates everyone's state at once. */
  const act = async (run: () => Promise<InterviewView>) => {
    setBusy(true);
    setError(null);
    try {
      interview.applyView(await run());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      ref={panelRef}
      aria-labelledby={headingId}
      className="absolute top-16 right-3 z-30 flex max-h-[calc(100%-5rem)] w-96 flex-col rounded-lg border bg-background text-sm shadow-sm"
    >
      <div className="flex items-center gap-1 border-b py-1 pr-1 pl-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="flex-1 font-semibold outline-none"
        >
          Interviewer
        </h2>
        <IconButton
          label={paused ? "Resume timer" : "Pause timer"}
          disabled={busy}
          onClick={() => void act(() => api.timer(id, { action: paused ? "resume" : "pause" }))}
        >
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton
          label="Add 5 minutes"
          disabled={busy}
          onClick={() => void act(() => api.timer(id, { action: "extend", minutes: 5 }))}
        >
          <Plus />
        </IconButton>
        <IconButton label="Run an AI review" onClick={onRunReview}>
          <Sparkles />
        </IconButton>
        <IconButton
          label="End interview"
          disabled={busy}
          onClick={() => {
            setConfirmEnd(true);
          }}
        >
          <Square />
        </IconButton>
        <IconButton label="Close interviewer panel" shortcut="Esc" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        Only interviewers can see this panel.
      </p>

      <div role="tablist" aria-label="Interviewer tools" className="flex gap-1 border-b px-2 py-1">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            id={`${headingId}-${t}`}
            aria-selected={tab === t}
            aria-controls={`${headingId}-${t}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => {
              setTab(t);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              const next =
                TABS[
                  (TABS.indexOf(t) + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) %
                    TABS.length
                ] ?? t;
              setTab(next);
              document.getElementById(`${headingId}-${next}`)?.focus();
            }}
            className={cn(
              "rounded-md px-2 py-1 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              tab === t ? "bg-secondary" : "text-muted-foreground hover:bg-accent",
            )}
          >
            {TAB_NAMES[t]}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="px-3 pt-2 text-destructive">
          {error}
        </p>
      )}
      <div
        role="tabpanel"
        id={`${headingId}-${tab}-panel`}
        aria-labelledby={`${headingId}-${tab}`}
        className="flex flex-col gap-3 overflow-y-auto p-3"
      >
        {tab === "question" && (
          <>
            {question === null ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading…
              </p>
            ) : (
              <>
                <p>{question.prompt}</p>
                <h3 className="text-xs font-semibold text-muted-foreground">Hints</h3>
                <ol className="flex flex-col gap-2">
                  {question.hints.map((hint, index) => {
                    const revealed = state.revealedHints.some((h) => h.index === index);
                    return (
                      <li key={hint} className="flex flex-col gap-1 rounded-md border p-2">
                        <span>{hint}</span>
                        {revealed ? (
                          <span className="text-xs font-medium text-emerald-800">
                            Shown to the candidate
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-start"
                            disabled={busy}
                            onClick={() => void act(() => api.revealHint(id, index))}
                          >
                            <Eye aria-hidden="true" />
                            Show to candidate
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </>
        )}
        {tab === "notes" && (
          <Notes api={api} interviewId={id} meId={me.userId} startedAt={state.timer.startedAt} />
        )}
        {tab === "scorecard" && <ScorecardForm api={api} interviewId={id} />}
        {tab === "people" && (
          <PeopleEditor
            me={me}
            people={people}
            current={state.participants}
            busy={busy}
            onSave={(participants) => void act(() => api.setParticipants(id, participants))}
          />
        )}
      </div>

      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End the interview?</DialogTitle>
            <DialogDescription>
              The timer stops and the board becomes read-only for the candidate. You can still
              finish your scorecard and notes afterwards. Run an AI review first if you want it in
              the summary.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setConfirmEnd(false);
                onRunReview();
              }}
            >
              <Sparkles aria-hidden="true" />
              Run AI review first
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmEnd(false);
                void act(async () => {
                  const view = await api.end(id);
                  onEnded(id);
                  return view;
                });
              }}
            >
              End interview
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

const minutesFormat = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
};

/** Timestamped private notes; each becomes a marker in the replay. */
function Notes({
  api,
  interviewId,
  meId,
  startedAt,
}: {
  api: InterviewApi;
  interviewId: string;
  meId: string;
  startedAt: number;
}) {
  const queryClient = useQueryClient();
  const key = ["interview-notes", interviewId];
  const notes = useQuery({
    queryKey: key,
    queryFn: () => api.notes(interviewId),
    // Other interviewers' notes appear within a few seconds (they never use the socket).
    refetchInterval: 10_000,
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftId = useId();

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      await api.addNote(interviewId, body);
      setDraft("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the note.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={draftId} className="text-xs font-semibold text-muted-foreground">
        New note (private to interviewers)
      </label>
      <textarea
        id={draftId}
        rows={3}
        maxLength={5000}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void add();
          }
        }}
        className="rounded-md border px-2 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder="What did you notice? (Ctrl/⌘+Enter to save)"
      />
      <Button
        size="sm"
        className="self-end"
        disabled={saving || !draft.trim()}
        onClick={() => void add()}
      >
        Add note
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Notes">
        {(notes.data ?? []).map((note) => (
          <NoteItem
            key={note.id}
            note={note}
            mine={note.authorId === meId}
            at={minutesFormat(Date.parse(note.createdAt) - startedAt)}
            onSave={async (body) => {
              await api.editNote(interviewId, note.id, body);
              await refresh();
            }}
            onDelete={async () => {
              await api.deleteNote(interviewId, note.id);
              await refresh();
            }}
          />
        ))}
      </ul>
      {notes.data?.length === 0 && <p className="text-muted-foreground">No notes yet.</p>}
    </div>
  );
}

function NoteItem({
  note,
  mine,
  at,
  onSave,
  onDelete,
}: {
  note: InterviewNote;
  mine: boolean;
  at: string;
  onSave: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const editId = useId();
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2">
      <span className="text-xs text-muted-foreground">{`${at} · ${note.authorName}`}</span>
      {editing ? (
        <>
          <label htmlFor={editId} className="sr-only">
            Edit note
          </label>
          <textarea
            id={editId}
            rows={3}
            maxLength={5000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
            }}
            className="rounded-md border px-2 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setBody(note.body);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!body.trim()}
              onClick={() =>
                void onSave(body.trim()).then(() => {
                  setEditing(false);
                })
              }
            >
              Save
            </Button>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap">{note.body}</p>
      )}
      {mine && !editing && (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void onDelete()}>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}

function PeopleEditor({
  me,
  people,
  current,
  busy,
  onSave,
}: {
  me: Person;
  people: Person[];
  current: { userId: string; name: string; role: InterviewRole }[];
  busy: boolean;
  onSave: (participants: { userId: string; role: InterviewRole }[]) => void;
}) {
  // Everyone already in the interview plus anyone who has joined the board since.
  const everyone = [
    ...current.filter((p) => p.userId !== me.userId),
    ...people.filter((p) => !current.some((c) => c.userId === p.userId)),
  ];
  const [roles, setRoles] = useState<Record<string, InterviewRole | "none">>(() =>
    Object.fromEntries(current.map((p) => [p.userId, p.role])),
  );
  const candidates = Object.values(roles).filter((r) => r === "candidate").length;
  return (
    <div className="flex flex-col gap-2">
      <Row label={`${me.name} (you)`}>
        <span className="text-muted-foreground">{INTERVIEW_ROLE_NAMES.interviewer}</span>
      </Row>
      {everyone.map((person) => (
        <Row key={person.userId} label={person.name}>
          <select
            aria-label={`Role for ${person.name}`}
            className="h-8 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={roles[person.userId] ?? "none"}
            onChange={(e) => {
              setRoles((r) => ({
                ...r,
                [person.userId]: e.target.value as InterviewRole | "none",
              }));
            }}
          >
            <option value="candidate">{INTERVIEW_ROLE_NAMES.candidate}</option>
            <option value="interviewer">{INTERVIEW_ROLE_NAMES.interviewer}</option>
            <option value="observer">{INTERVIEW_ROLE_NAMES.observer}</option>
            <option value="none">Not taking part</option>
          </select>
        </Row>
      ))}
      {candidates > 1 && (
        <p role="alert" className="text-destructive">
          An interview has one candidate.
        </p>
      )}
      <Button
        size="sm"
        className="self-end"
        disabled={busy || candidates > 1}
        onClick={() => {
          onSave(
            Object.entries(roles).flatMap(([userId, role]) =>
              role === "none" || userId === me.userId ? [] : [{ userId, role }],
            ),
          );
        }}
      >
        Save roles
      </Button>
      <p className="text-xs text-muted-foreground">
        Observers can watch but not edit. People must have access to the board (Share) first.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      {children}
    </div>
  );
}
