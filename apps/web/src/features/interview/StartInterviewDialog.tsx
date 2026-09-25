import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  INTERVIEW_ROLE_NAMES,
  type InterviewQuestion,
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
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/apiClient";
import { cn } from "@/lib/utils";
import type { InterviewApi } from "./api";

export interface Person {
  userId: string;
  name: string;
}

const DURATIONS = [30, 45, 60, 90] as const;
type Assignment = InterviewRole | "none";

interface StartInterviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: InterviewApi;
  boardId: string;
  shareToken: string | undefined;
  me: Person;
  /** Other signed-in people on the board right now (from presence). */
  people: Person[];
  onStarted: (view: InterviewView) => void;
  onUpgrade: (message: string) => void;
}

/** Pick a question, a length and who plays which role, then start the clock. */
export function StartInterviewDialog(props: StartInterviewDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start an interview</DialogTitle>
          <DialogDescription>
            Everyone on the board sees the question and the timer. Hints, your notes and the
            scorecard are visible to interviewers only.
          </DialogDescription>
        </DialogHeader>
        {props.open && <StartForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function StartForm({
  api,
  boardId,
  shareToken,
  me,
  people,
  onStarted,
  onUpgrade,
  onOpenChange,
}: StartInterviewDialogProps) {
  const questions = useQuery({
    queryKey: ["interview-questions"],
    queryFn: () => api.questions(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [search, setSearch] = useState("");
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(45);
  const [roles, setRoles] = useState<Record<string, Assignment>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId();
  const durationId = useId();

  const upgradeNeeded =
    questions.error instanceof ApiRequestError && questions.error.status === 402;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (questions.data ?? []).filter(
      (question) =>
        q === "" ||
        question.title.toLowerCase().includes(q) ||
        question.tags.some((tag) => tag.includes(q)),
    );
  }, [questions.data, search]);
  const selected = questions.data?.find((q) => q.id === questionId) ?? null;
  const roleOf = (userId: string): Assignment =>
    roles[userId] ?? (people.length === 1 ? "candidate" : "none");
  const candidates = people.filter((p) => roleOf(p.userId) === "candidate").length;

  const submit = async () => {
    if (!selected) {
      setError("Choose a question.");
      return;
    }
    if (candidates > 1) {
      setError("An interview has one candidate.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const view = await api.start(
        boardId,
        {
          questionId: selected.id,
          durationMinutes: duration,
          participants: people.flatMap((p) => {
            const role = roleOf(p.userId);
            return role === "none" ? [] : [{ userId: p.userId, role }];
          }),
        },
        shareToken,
      );
      onStarted(view);
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 402) {
        onOpenChange(false);
        onUpgrade(caught.message);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not start the interview.");
    } finally {
      setSubmitting(false);
    }
  };

  if (upgradeNeeded)
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>Interview mode is included in the Team plan.</p>
        <Button
          className="self-end"
          onClick={() => {
            onOpenChange(false);
            onUpgrade("Interview mode is included in the Team plan.");
          }}
        >
          See plans
        </Button>
      </div>
    );

  return (
    <form
      className="flex flex-col gap-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Question</legend>
        <label htmlFor={searchId} className="sr-only">
          Search questions
        </label>
        <Input
          id={searchId}
          placeholder="Search questions or tags"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        {questions.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading questions…
          </p>
        )}
        {questions.isError && (
          <p role="alert" className="text-destructive">
            Could not load the question bank.
          </p>
        )}
        <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {filtered.map((question) => (
            <QuestionOption
              key={question.id}
              question={question}
              checked={question.id === questionId}
              onSelect={() => {
                setQuestionId(question.id);
              }}
            />
          ))}
        </div>
        {selected && <p className="text-muted-foreground">{selected.prompt}</p>}
      </fieldset>

      <div className="flex items-center gap-2">
        <label htmlFor={durationId} className="font-medium">
          Length
        </label>
        <select
          id={durationId}
          className="h-8 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={duration}
          onChange={(e) => {
            setDuration(Number(e.target.value));
          }}
        >
          {DURATIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {`${String(minutes)} minutes`}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 font-medium">People</legend>
        <div className="flex items-center justify-between">
          <span>{`${me.name} (you)`}</span>
          <span className="text-muted-foreground">Interviewer</span>
        </div>
        {people.map((person) => (
          <PersonRole
            key={person.userId}
            person={person}
            value={roleOf(person.userId)}
            onChange={(role) => {
              setRoles((current) => ({ ...current, [person.userId]: role }));
            }}
          />
        ))}
        {people.length === 0 && (
          <p className="text-muted-foreground">
            Nobody else is on the board yet. Share the board with your candidate (Share → invite as
            editor) and start once they have joined, or assign roles later.
          </p>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !selected}>
          {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          Start interview
        </Button>
      </div>
    </form>
  );
}

/** A native radio (arrow keys move between questions) styled as a card. */
function QuestionOption({
  question,
  checked,
  onSelect,
}: {
  question: InterviewQuestion;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
        checked ? "border-violet-600 bg-violet-50" : "hover:bg-accent",
      )}
    >
      <input
        type="radio"
        name="interview-question"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
      />
      <span className="font-medium">{question.title}</span>
      <span className="text-xs text-muted-foreground">
        {`${question.difficulty} · ${question.tags.join(", ")}`}
      </span>
    </label>
  );
}

function PersonRole({
  person,
  value,
  onChange,
}: {
  person: Person;
  value: Assignment;
  onChange: (role: Assignment) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id}>{person.name}</label>
      <select
        id={id}
        className="h-8 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={value}
        onChange={(e) => {
          onChange(e.target.value as Assignment);
        }}
      >
        <option value="candidate">{INTERVIEW_ROLE_NAMES.candidate}</option>
        <option value="interviewer">{INTERVIEW_ROLE_NAMES.interviewer}</option>
        <option value="observer">{INTERVIEW_ROLE_NAMES.observer}</option>
        <option value="none">Not taking part</option>
      </select>
    </div>
  );
}
