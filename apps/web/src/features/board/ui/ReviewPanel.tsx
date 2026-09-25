import { Loader2, Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import {
  diffReviews,
  extractGraph,
  graphFingerprint,
  REVIEW_DIMENSION_LABELS,
  REVIEW_DIMENSIONS,
  type ReviewFinding,
  type ReviewStage,
} from "@whiteboard/graph";
import type { BoardStore } from "@whiteboard/shared/board";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SEVERITY_META } from "../check/severity";
import type { ReviewStore } from "../review/ReviewStore";
import { IconButton } from "./IconButton";

const STAGES: { stage: ReviewStage; label: string }[] = [
  { stage: "preparing", label: "Reading the board" },
  { stage: "reviewing", label: "Reviewing the design" },
  { stage: "validating", label: "Checking the findings" },
];

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface ReviewPanelProps {
  review: ReviewStore;
  store: BoardStore;
  onNewReview: () => void;
  onClose: () => void;
  /** Highlight and zoom to a finding's shapes. */
  onFocusFinding: (finding: ReviewFinding) => void;
  /** Live hints toggle (Pro+); null hides it (viewers). */
  hints: {
    available: boolean;
    enabled: boolean;
    notice: string | null;
    onToggle: (enabled: boolean) => void;
    onUpgrade: () => void;
  } | null;
}

/** AI review results next to the canvas: progress, scores, numbered findings, comparison. */
export function ReviewPanel({
  review,
  store,
  onNewReview,
  onClose,
  onFocusFinding,
  hints,
}: ReviewPanelProps) {
  const state = useSyncExternalStore(review.subscribe, review.get);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const headingId = useId();
  const historyId = useId();
  const hintsId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const current = state.current;
  const result = current?.review ?? null;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape inside the panel closes it (and not also the board's selection).
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

  // A pin clicked on the canvas scrolls its finding into view in the list.
  const focusedId = state.focus?.findingId ?? null;
  useEffect(() => {
    if (!focusedId) return;
    panelRef.current
      ?.querySelector(`[data-finding-id="${focusedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

  const stale = useMemo(
    () =>
      current !== null &&
      graphFingerprint(current.graph) !== graphFingerprint(extractGraph(snapshot.ordered)),
    [current, snapshot],
  );
  const diff = useMemo(
    () =>
      state.compare && result && state.previous?.review
        ? diffReviews(state.previous.review, result)
        : null,
    [state.compare, state.previous, result],
  );

  const history = state.history ?? [];
  const completedCount = history.filter((r) => r.status === "completed").length;

  return (
    <aside
      ref={panelRef}
      aria-labelledby={headingId}
      aria-busy={state.running}
      className="absolute top-16 right-3 z-20 flex max-h-[calc(100%-5rem)] w-80 flex-col rounded-lg border bg-background text-sm shadow-sm"
    >
      <div className="flex items-center gap-1 border-b py-1 pr-1 pl-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="flex-1 font-semibold outline-none"
        >
          AI review
        </h2>
        <IconButton
          label="New AI review"
          shortcut="⇧R"
          onClick={onNewReview}
          disabled={state.running}
        >
          <Plus />
        </IconButton>
        <IconButton label="Close AI review" shortcut="Esc" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto p-3">
        {history.length > 1 && !state.running && (
          <div className="flex flex-col gap-1">
            <label htmlFor={historyId} className="text-xs font-medium text-muted-foreground">
              Review
            </label>
            <select
              id={historyId}
              className="h-8 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={current?.id ?? ""}
              onChange={(e) => void review.select(e.target.value)}
            >
              {history.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${dateFormat.format(new Date(r.createdAt))} — ${
                    r.status === "completed"
                      ? `${String(r.findingCount)} findings, ${String(r.overallScore ?? "–")}/10`
                      : r.status
                  }`}
                </option>
              ))}
            </select>
          </div>
        )}

        {state.running && (
          <div className="flex flex-col gap-2 rounded-md border p-2.5">
            <ol aria-label="Review progress" className="flex flex-col gap-1.5">
              {STAGES.map(({ stage, label }, i) => {
                const index = STAGES.findIndex((s) => s.stage === state.stage);
                const status = i < index ? "done" : i === index ? "active" : "pending";
                return (
                  <li
                    key={stage}
                    className={cn(
                      "flex items-center gap-2",
                      status === "pending" && "text-muted-foreground",
                    )}
                    aria-current={status === "active" ? "step" : undefined}
                  >
                    {status === "active" ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true" className="inline-block w-4 text-center">
                        {status === "done" ? "✓" : "·"}
                      </span>
                    )}
                    {label}
                    {stage === "reviewing" && status === "active" && state.outputTokens > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {`(${String(state.outputTokens)} tokens written)`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="text-xs text-muted-foreground">This usually takes 20–60 seconds.</p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => {
                review.cancel();
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        <div role="status" aria-live="polite" className="sr-only">
          {state.running
            ? `Reviewing: ${STAGES.find((s) => s.stage === state.stage)?.label ?? ""}`
            : state.error
              ? state.error.message
              : result
                ? `Review ready: ${String(result.findings.length)} findings.`
                : ""}
        </div>

        {state.error && !state.running && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-900"
          >
            <span>{state.error.message}</span>
            <Button size="sm" variant="outline" className="self-start" onClick={onNewReview}>
              Try again
            </Button>
          </div>
        )}

        {!state.running && !current && state.history !== null && !state.error && (
          <div className="flex flex-col gap-2">
            <p>No AI reviews of this board yet.</p>
            <Button size="sm" className="self-start" onClick={onNewReview}>
              Review this design
            </Button>
          </div>
        )}

        {current && !result && !state.running && (
          <p className="text-muted-foreground">
            {current.status === "running"
              ? "This review is still running."
              : "This review didn't complete (it didn't count toward your quota)."}
          </p>
        )}

        {current && result && !state.running && (
          <>
            {stale && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900">
                <span>The board changed since this review.</span>
                <Button size="sm" variant="outline" onClick={onNewReview}>
                  Review again
                </Button>
              </div>
            )}
            {current.problemStatement && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Problem: </span>
                {current.problemStatement}
              </p>
            )}
            <p>{result.summary}</p>

            <section aria-label="Scores" className="flex flex-col gap-1.5">
              {REVIEW_DIMENSIONS.map((dimension) => {
                const score = result.scores[dimension];
                const delta = diff?.scoreDeltas[dimension] ?? 0;
                return (
                  <div key={dimension} className="flex items-center gap-2">
                    <span className="w-24 shrink-0">{REVIEW_DIMENSION_LABELS[dimension]}</span>
                    <meter
                      min={0}
                      max={10}
                      low={4}
                      high={7}
                      optimum={10}
                      value={score}
                      aria-label={`${REVIEW_DIMENSION_LABELS[dimension]} score`}
                      className="h-2 flex-1"
                    />
                    <span className="w-10 text-right tabular-nums">{`${String(score)}/10`}</span>
                    {diff && (
                      <span
                        className={cn(
                          "w-8 text-right text-xs tabular-nums",
                          delta > 0
                            ? "text-green-800"
                            : delta < 0
                              ? "text-red-800"
                              : "text-muted-foreground",
                        )}
                        aria-label={`${delta >= 0 ? "up" : "down"} ${String(Math.abs(delta))} since the previous review`}
                      >
                        {delta > 0 ? `+${String(delta)}` : delta === 0 ? "±0" : String(delta)}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>

            {completedCount > 1 && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.compare}
                  disabled={!state.previous}
                  onChange={(e) => {
                    review.setCompare(e.target.checked);
                  }}
                  className="size-4 accent-foreground"
                />
                Compare with the previous review
              </label>
            )}

            {result.findings.length === 0 ? (
              <p className="font-medium">No findings — nice work.</p>
            ) : (
              <ol aria-label="Findings" className="flex flex-col gap-2">
                {result.findings.map((finding, index) => {
                  const meta = SEVERITY_META[finding.severity];
                  const Icon = meta.icon;
                  const active = focusedId === finding.id;
                  const change = diff?.changes.get(finding.id);
                  return (
                    <li key={finding.id} data-finding-id={finding.id}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          onFocusFinding(finding);
                        }}
                        className={cn(
                          "flex w-full flex-col gap-1.5 rounded-md border p-2.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                          active && "border-foreground/40 bg-accent",
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-5 items-center justify-center rounded-full text-xs font-semibold text-white",
                              meta.pinClass,
                            )}
                          >
                            {index + 1}
                          </span>
                          <span className="sr-only">{`Finding ${String(index + 1)}:`}</span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium",
                              meta.badgeClass,
                            )}
                          >
                            <Icon className="size-3.5" aria-hidden="true" />
                            {meta.label}
                          </span>
                          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                            {REVIEW_DIMENSION_LABELS[finding.dimension]}
                          </span>
                          {change && (
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-xs font-medium",
                                change === "new"
                                  ? "bg-violet-50 text-violet-800"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {change === "new" ? "New" : "Still open"}
                            </span>
                          )}
                        </span>
                        <span className="font-medium">{finding.title}</span>
                        <span className="text-muted-foreground">{finding.explanation}</span>
                        <span>
                          <span className="font-medium">Fix: </span>
                          {finding.suggestion}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}

            {diff && diff.resolved.length > 0 && (
              <section
                aria-label="Resolved since the previous review"
                className="flex flex-col gap-1"
              >
                <h3 className="font-medium">{`Resolved since the previous review (${String(diff.resolved.length)})`}</h3>
                <ul className="flex flex-col gap-1">
                  {diff.resolved.map((f) => (
                    <li key={f.id} className="rounded-md bg-green-50 px-2 py-1 text-green-900">
                      <span className="sr-only">Resolved: </span>
                      {f.title}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {result.followUpQuestions.length > 0 && (
              <section aria-label="Follow-up questions" className="flex flex-col gap-1">
                <h3 className="font-medium">Questions an interviewer would ask next</h3>
                <ul className="list-disc pl-5">
                  {result.followUpQuestions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </section>
            )}

            <p className="text-xs text-muted-foreground">
              {`${dateFormat.format(new Date(current.createdAt))}${current.requestedBy ? ` · by ${current.requestedBy.name}` : ""} · AI can make mistakes — check before acting.`}
            </p>
          </>
        )}

        {hints && (
          <div className="flex flex-col gap-1 border-t pt-3">
            <label className="flex items-center gap-2" htmlFor={hintsId}>
              <input
                id={hintsId}
                type="checkbox"
                checked={hints.enabled}
                disabled={!hints.available}
                onChange={(e) => {
                  hints.onToggle(e.target.checked);
                }}
                className="size-4 accent-foreground"
              />
              Live hints while I draw
              {!hints.available && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">Pro</span>
              )}
            </label>
            {!hints.available && (
              <Button
                variant="link"
                size="sm"
                className="h-auto self-start p-0"
                onClick={hints.onUpgrade}
              >
                See plans
              </Button>
            )}
            {hints.notice && <p className="text-xs text-muted-foreground">{hints.notice}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}
