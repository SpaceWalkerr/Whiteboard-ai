import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import {
  RECOMMENDATION_NAMES,
  RECOMMENDATIONS,
  RUBRIC_DIMENSIONS,
  SCORE_LABELS,
  type Recommendation,
  type Scorecard,
  type ScorecardInput,
} from "@whiteboard/shared/interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InterviewApi } from "./api";

const SCORES = [1, 2, 3, 4] as const;

/** My rubric scorecard for this interview: 1–4 per dimension with comments. */
export function ScorecardForm({ api, interviewId }: { api: InterviewApi; interviewId: string }) {
  const mine = useQuery({
    queryKey: ["interview-scorecard", interviewId],
    queryFn: () => api.scorecard(interviewId),
  });
  if (mine.isPending)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  if (mine.isError) return <p role="alert">Could not load your scorecard.</p>;
  return <Form api={api} interviewId={interviewId} initial={mine.data} />;
}

function Form({
  api,
  interviewId,
  initial,
}: {
  api: InterviewApi;
  interviewId: string;
  initial: Scorecard | null;
}) {
  const queryClient = useQueryClient();
  const [scores, setScores] = useState<ScorecardInput["scores"]>(initial?.scores ?? {});
  const [recommendation, setRecommendation] = useState<Recommendation | null>(
    initial?.recommendation ?? null,
  );
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [submittedAt, setSubmittedAt] = useState(initial?.submittedAt ?? null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const summaryId = useId();

  const save = async (submit: boolean) => {
    setStatus("saving");
    try {
      const saved = await api.saveScorecard(interviewId, {
        scores,
        recommendation,
        summary,
        submit,
      });
      setSubmittedAt(saved?.submittedAt ?? null);
      setStatus("saved");
      queryClient.setQueryData(["interview-scorecard", interviewId], saved);
    } catch {
      setStatus("error");
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      {RUBRIC_DIMENSIONS.map((dimension) => {
        const value = scores[dimension.id] ?? { score: null, comment: "" };
        return (
          <fieldset key={dimension.id} className="flex flex-col gap-1 rounded-md border p-2">
            <legend className="px-1 font-medium">{dimension.name}</legend>
            <p className="text-xs text-muted-foreground">{dimension.description}</p>
            <div className="flex gap-1">
              {SCORES.map((score) => (
                <label
                  key={score}
                  className={cn(
                    "relative flex flex-1 cursor-pointer flex-col items-center rounded-md border px-1 py-0.5 text-xs has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                    value.score === score ? "border-violet-600 bg-violet-50" : "hover:bg-accent",
                  )}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`score-${dimension.id}`}
                    checked={value.score === score}
                    onChange={() => {
                      setScores((s) => ({ ...s, [dimension.id]: { ...value, score } }));
                    }}
                  />
                  <span className="text-sm font-semibold">{score}</span>
                  {SCORE_LABELS[score]}
                </label>
              ))}
            </div>
            <textarea
              aria-label={`Comment on ${dimension.name}`}
              rows={2}
              maxLength={2000}
              value={value.comment}
              placeholder="Evidence (optional)"
              onChange={(e) => {
                setScores((s) => ({ ...s, [dimension.id]: { ...value, comment: e.target.value } }));
              }}
              className="rounded-md border px-2 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </fieldset>
        );
      })}

      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">Recommendation</legend>
        <div className="grid grid-cols-2 gap-1">
          {RECOMMENDATIONS.map((option) => (
            <label
              key={option}
              className={cn(
                "relative cursor-pointer rounded-md border px-2 py-1 text-center has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                recommendation === option ? "border-violet-600 bg-violet-50" : "hover:bg-accent",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name="recommendation"
                checked={recommendation === option}
                onChange={() => {
                  setRecommendation(option);
                }}
              />
              {RECOMMENDATION_NAMES[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor={summaryId} className="font-medium">
        Summary
      </label>
      <textarea
        id={summaryId}
        rows={4}
        maxLength={5000}
        value={summary}
        onChange={(e) => {
          setSummary(e.target.value);
        }}
        className="rounded-md border px-2 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />

      <div className="flex items-center justify-end gap-2">
        <span role="status" className="mr-auto text-xs text-muted-foreground">
          {status === "saving"
            ? "Saving…"
            : status === "error"
              ? "Could not save — try again."
              : submittedAt
                ? "Submitted"
                : status === "saved"
                  ? "Draft saved"
                  : ""}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void save(false)}>
          Save draft
        </Button>
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {submittedAt ? "Update" : "Submit"}
        </Button>
      </div>
    </form>
  );
}
