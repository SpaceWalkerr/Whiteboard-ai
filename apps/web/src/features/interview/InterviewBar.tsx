import { ChevronDown, ChevronUp, ClipboardList, Pause, Timer } from "lucide-react";
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import {
  formatCountdown,
  INTERVIEW_ROLE_NAMES,
  type InterviewRole,
  type PublicInterviewState,
} from "@whiteboard/shared/interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InterviewStore } from "./InterviewStore";
import { useCountdown } from "./useCountdown";

/** Below this, the countdown turns amber (and red once over time). */
const WARNING_MS = 5 * 60_000;

interface InterviewBarProps {
  interview: InterviewStore;
  /** Interviewers: toggles their private panel. */
  onTogglePanel: () => void;
  panelOpen: boolean;
}

/**
 * Shown to everyone on a board with an interview: the question, requirements and revealed
 * hints, the shared countdown and who plays which role. Everything here comes from the public
 * interview state; interviewer-only content lives in the InterviewerPanel.
 */
export function InterviewBar({ interview, onTogglePanel, panelOpen }: InterviewBarProps) {
  const { state, myRole } = useSyncExternalStore(interview.subscribe, interview.get);
  const serverNow = useCallback(() => interview.serverNow(), [interview]);
  const remaining = useCountdown(state?.timer ?? null, serverNow);
  const [expanded, setExpanded] = useState(true);
  const detailsId = useId();
  if (!state) return null;
  const ended = state.status === "ended";
  const paused = state.timer.pausedAt !== null;
  const hiringSide = myRole === "interviewer" || myRole === "observer";

  return (
    <section
      aria-label="Interview"
      className="absolute top-16 left-1/2 z-20 flex w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 flex-col rounded-lg border bg-background text-sm shadow-sm"
    >
      <div className="flex items-center gap-2 py-1 pr-1 pl-3">
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-900">
          {ended ? "Interview ended" : "Interview"}
        </span>
        <h2 className="min-w-0 flex-1 truncate font-semibold">{state.question.title}</h2>
        {remaining !== null && !ended && <Countdown remaining={remaining} paused={paused} />}
        {ended && hiringSide && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/interviews/${state.interviewId}`}>View summary</Link>
          </Button>
        )}
        {myRole === "interviewer" && !ended && (
          <Button
            size="sm"
            variant={panelOpen ? "secondary" : "outline"}
            aria-pressed={panelOpen}
            onClick={onTogglePanel}
          >
            <ClipboardList aria-hidden="true" />
            Interviewer
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? "Hide question details" : "Show question details"}
          onClick={() => {
            setExpanded((v) => !v);
          }}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      {expanded && <Details id={detailsId} state={state} myRole={myRole} />}
    </section>
  );
}

function Countdown({ remaining, paused }: { remaining: number; paused: boolean }) {
  const over = remaining < 0;
  return (
    <span
      role="timer"
      aria-label={`${over ? "Over time by" : "Time left"} ${formatCountdown(Math.abs(remaining))}${paused ? ", paused" : ""}`}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-sm font-semibold tabular-nums",
        over
          ? "bg-red-100 text-red-900"
          : remaining < WARNING_MS
            ? "bg-amber-100 text-amber-900"
            : "bg-muted text-foreground",
      )}
    >
      {paused ? (
        <Pause className="size-3.5" aria-hidden="true" />
      ) : (
        <Timer className="size-3.5" aria-hidden="true" />
      )}
      {formatCountdown(remaining)}
      {over && <span className="font-sans text-xs font-medium">over</span>}
    </span>
  );
}

function Details({
  id,
  state,
  myRole,
}: {
  id: string;
  state: PublicInterviewState;
  myRole: InterviewRole | null;
}) {
  const { question, revealedHints, participants } = state;
  return (
    <div id={id} className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto border-t px-3 py-2">
      <p>{question.prompt}</p>
      {/* Hints first: a newly revealed one must be seen without scrolling. */}
      {revealedHints.length > 0 && (
        <div role="status" aria-live="polite">
          <h3 className="text-xs font-semibold text-muted-foreground">Hints</h3>
          <ul className="flex flex-col gap-1">
            {revealedHints.map((hint) => (
              <li key={hint.index} className="rounded-md bg-amber-50 px-2 py-1 text-amber-950">
                {hint.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <RequirementList title="Functional requirements" items={question.requirements.functional} />
      <RequirementList
        title="Non-functional requirements"
        items={question.requirements.nonFunctional}
      />
      <p className="text-xs text-muted-foreground">
        {participants
          .map((p) => `${p.name} (${INTERVIEW_ROLE_NAMES[p.role].toLowerCase()})`)
          .join(" · ")}
        {myRole === null ? "" : ` — you are the ${INTERVIEW_ROLE_NAMES[myRole].toLowerCase()}`}
      </p>
    </div>
  );
}

function RequirementList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul className="list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
