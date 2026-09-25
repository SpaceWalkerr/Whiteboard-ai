import { useId, useState } from "react";
import { PROBLEM_STATEMENT_MAX, REQUIREMENTS_MAX, type ReviewRequest } from "@whiteboard/graph";
import { PLAN_NAMES } from "@whiteboard/shared/plans";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAiQuota } from "../review/useAiQuota";

const textareaClass =
  "min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Starts an AI review: what the design is for (optional but makes the review much better),
 * how many reviews are left this month, and what gets sent to the AI.
 */
export function ReviewDialog({
  open,
  onOpenChange,
  initial,
  saving,
  onStart,
  onUpgrade,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ReviewRequest;
  /** Edits not yet stored on the server (the review reads the stored board). */
  saving: boolean;
  onStart: (request: ReviewRequest) => void;
  onUpgrade: (message: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so the fields start from `initial` each time. */}
        {open && (
          <ReviewForm initial={initial} saving={saving} onStart={onStart} onUpgrade={onUpgrade} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewForm({
  initial,
  saving,
  onStart,
  onUpgrade,
}: {
  initial: ReviewRequest;
  saving: boolean;
  onStart: (request: ReviewRequest) => void;
  onUpgrade: (message: string) => void;
}) {
  const [problemStatement, setProblemStatement] = useState(initial.problemStatement);
  const [requirements, setRequirements] = useState(initial.requirements);
  const problemId = useId();
  const requirementsId = useId();
  const quotaId = useId();
  const quota = useAiQuota();
  const q = quota.data;
  const left = q ? Math.max(0, q.reviewsLimit - q.reviewsUsed) : null;
  const exhausted = left === 0;
  const unavailable = q?.available === false;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (exhausted && q) {
          onUpgrade(
            `You've used all ${String(q.reviewsLimit)} AI reviews included in the ${PLAN_NAMES[q.plan]} plan this month.`,
          );
          return;
        }
        onStart({ problemStatement: problemStatement.trim(), requirements: requirements.trim() });
      }}
    >
      <DialogHeader>
        <DialogTitle>AI design review</DialogTitle>
        <DialogDescription>
          Claude reviews the components and connections on this board like a senior engineer and
          points at the shapes each finding is about.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={problemId} className="text-sm font-medium">
          What are you designing?{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={problemId}
          className={textareaClass}
          maxLength={PROBLEM_STATEMENT_MAX}
          placeholder="e.g. Design a URL shortener, 100M new URLs/day"
          value={problemStatement}
          onChange={(e) => {
            setProblemStatement(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={requirementsId} className="text-sm font-medium">
          Requirements <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={requirementsId}
          className={textareaClass}
          maxLength={REQUIREMENTS_MAX}
          placeholder="e.g. 10:1 reads to writes, redirects p99 < 50 ms, 99.9% availability"
          value={requirements}
          onChange={(e) => {
            setRequirements(e.target.value);
          }}
        />
      </div>

      <p id={quotaId} className="text-sm" aria-live="polite">
        {quota.isPending
          ? "Checking your AI reviews…"
          : quota.isError
            ? "Couldn't check your AI reviews."
            : unavailable
              ? "AI reviews are unavailable right now. Please try again later."
              : q
                ? `${String(left)} of ${String(q.reviewsLimit)} reviews left this month (${PLAN_NAMES[q.plan]} plan).`
                : null}
      </p>
      <p className="text-xs text-muted-foreground">
        The board&apos;s components, connections and labels, plus the text above, are sent to
        Anthropic&apos;s Claude API to produce the review. Nothing else on the board is sent.
      </p>

      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          aria-describedby={quotaId}
          disabled={saving || unavailable || quota.isPending}
        >
          {saving ? "Saving your changes…" : exhausted ? "See plans" : "Start review"}
        </Button>
      </div>
    </form>
  );
}
