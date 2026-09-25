import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, FileDown, Loader2, PlayCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  REVIEW_DIMENSION_LABELS,
  REVIEW_DIMENSIONS,
  type InterviewSummary,
  type ReviewRecord,
} from "@whiteboard/graph";
import {
  averageScore,
  elapsedMs,
  INTERVIEW_ROLE_NAMES,
  RECOMMENDATION_NAMES,
  RUBRIC_DIMENSIONS,
  SCORE_LABELS,
  type Scorecard,
} from "@whiteboard/shared/interview";
import { useAuth } from "@/auth/authContext";
import { FullPageMessage, LoadingPage } from "@/auth/RequireAuth";
import { Button } from "@/components/ui/button";
import { ApiRequestError } from "@/lib/apiClient";
import { SEVERITY_META } from "@/features/board/check/severity";
import { interviewApi, type InterviewApi } from "./api";
import { sessionClock } from "./replay/clock";
import { useInterviewShareToken } from "./shareToken";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * /interviews/:id — the interview summary for the hiring side: the question, the AI review,
 * every scorecard, notes (interviewers only), links to the replay, share links and a PDF.
 * The server decides what the caller may see; candidates are refused outright.
 */
export function SummaryPage() {
  const { interviewId = "" } = useParams();
  const { api: client } = useAuth();
  const [api] = useState(() => interviewApi(client));
  const shareToken = useInterviewShareToken(interviewId);
  const summary = useQuery({
    queryKey: ["interview-summary", interviewId],
    queryFn: () => api.summary(interviewId, shareToken),
    retry: false,
  });

  if (summary.isPending) return <LoadingPage label="Loading the interview…" />;
  if (summary.isError) {
    const status = summary.error instanceof ApiRequestError ? summary.error.status : 0;
    return (
      <FullPageMessage
        title={status === 403 || status === 404 ? "No access" : "Something went wrong"}
      >
        {status === 403 || status === 404
          ? "This interview summary isn't available to you. Ask an interviewer for a link."
          : "Could not load the interview. Please try again."}
      </FullPageMessage>
    );
  }
  return <Summary data={summary.data} api={api} shareToken={shareToken} />;
}

function Summary({
  data,
  api,
  shareToken,
}: {
  data: InterviewSummary;
  api: InterviewApi;
  shareToken: string | undefined;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const review = data.reviews[0] ?? null;
  // An interview still in progress is measured up to when the page was opened.
  const [openedAt] = useState(() => Date.now());
  const duration = elapsedMs(data.timer, data.timer.endedAt ?? openedAt);
  const candidate = data.participants.find((p) => p.role === "candidate");

  const exportPdf = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { exportSummaryPdf } = await import("./summaryPdf");
      await exportSummaryPdf(data, () => api.replay(data.interviewId, shareToken), openedAt);
    } catch {
      setExportError("Could not create the PDF. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8 text-sm sm:px-6">
      <header className="flex flex-col gap-3">
        {data.myRole !== null && (
          <Link
            to={`/board/${data.boardId}`}
            className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:underline"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> {data.boardTitle}
          </Link>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-wide text-violet-800 uppercase">
              Interview summary
            </p>
            <h1 className="text-2xl font-bold tracking-tight">{data.question.title}</h1>
            <p className="text-muted-foreground">
              {`${dateFormat.format(new Date(data.timer.startedAt))} · ${sessionClock(duration)} long · ${
                data.status === "ended" ? "ended" : "in progress"
              }${candidate ? ` · candidate: ${candidate.name}` : ""}`}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to={`/interviews/${data.interviewId}/replay`}>
              <PlayCircle aria-hidden="true" /> Replay
            </Link>
          </Button>
          <Button variant="outline" disabled={exporting} onClick={() => void exportPdf()}>
            {exporting ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <FileDown aria-hidden="true" />
            )}
            Export PDF
          </Button>
        </div>
        {exportError && (
          <p role="alert" className="text-destructive">
            {exportError}
          </p>
        )}
        <p className="text-muted-foreground">
          {data.participants
            .map((p) => `${p.name} (${INTERVIEW_ROLE_NAMES[p.role].toLowerCase()})`)
            .join(" · ")}
        </p>
      </header>

      <Section title="Question">
        <p>{data.question.prompt}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <List title="Functional requirements" items={data.question.requirements.functional} />
          <List
            title="Non-functional requirements"
            items={data.question.requirements.nonFunctional}
          />
        </div>
        <h3 className="font-semibold">Hints</h3>
        <ol className="list-decimal pl-5">
          {data.question.hints.map((hint, i) => (
            <li key={hint}>
              {hint}{" "}
              <span className="text-xs text-muted-foreground">
                {data.revealedHints.includes(i) ? "(given)" : "(not given)"}
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="AI design review">
        {review ? (
          <ReviewSummary review={review} />
        ) : (
          <p className="text-muted-foreground">No AI review was run during this interview.</p>
        )}
      </Section>

      <Section title="Scorecards">
        {data.scorecards.length === 0 ? (
          <p className="text-muted-foreground">No scorecards yet.</p>
        ) : (
          data.scorecards.map((card) => <ScorecardView key={card.interviewerId} card={card} />)
        )}
      </Section>

      {data.notes !== null && (
        <Section title="Interviewer notes" note="Visible to interviewers only.">
          {data.notes.length === 0 ? (
            <p className="text-muted-foreground">No notes.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.notes.map((note) => (
                <li key={note.id} className="rounded-md border p-2">
                  <p className="text-xs text-muted-foreground">
                    {`${sessionClock(Date.parse(note.createdAt) - data.timer.startedAt)} · ${note.authorName}`}
                  </p>
                  <p className="whitespace-pre-wrap">{note.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {data.canShare && <ShareLinks api={api} interviewId={data.interviewId} />}
    </main>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label={title}>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <ul className="list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ReviewSummary({ review }: { review: ReviewRecord }) {
  const result = review.review;
  if (!result) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {`${dateFormat.format(new Date(review.createdAt))}${review.requestedBy ? ` · requested by ${review.requestedBy.name}` : ""}`}
      </p>
      <p>{result.summary}</p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {REVIEW_DIMENSIONS.map((d) => (
          <div key={d} className="rounded-md border p-2">
            <dt className="text-xs text-muted-foreground">{REVIEW_DIMENSION_LABELS[d]}</dt>
            <dd className="text-lg font-semibold">{`${String(result.scores[d])}/10`}</dd>
          </div>
        ))}
      </dl>
      <ol className="flex flex-col gap-2">
        {result.findings.map((finding, i) => {
          const meta = SEVERITY_META[finding.severity];
          return (
            <li key={finding.id} className="rounded-md border p-2">
              <p className="flex items-center gap-2 font-medium">
                <span className={`rounded border px-1.5 text-xs ${meta.badgeClass}`}>
                  {meta.label}
                </span>
                {`${String(i + 1)}. ${finding.title}`}
              </p>
              <p>{finding.explanation}</p>
              <p className="text-muted-foreground">{`Fix: ${finding.suggestion}`}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ScorecardView({ card }: { card: Scorecard }) {
  const average = averageScore(card.scores);
  return (
    <article className="flex flex-col gap-2 rounded-md border p-3">
      <h3 className="font-semibold">
        {card.interviewerName}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {card.submittedAt ? "submitted" : "draft"}
        </span>
      </h3>
      <p>
        {`Recommendation: ${card.recommendation ? RECOMMENDATION_NAMES[card.recommendation] : "—"}`}
        {average !== null && ` · average ${String(average)}/4`}
      </p>
      <table className="w-full text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Dimension
            </th>
            <th scope="col" className="py-1 font-medium">
              Score
            </th>
            <th scope="col" className="py-1 font-medium">
              Comment
            </th>
          </tr>
        </thead>
        <tbody>
          {RUBRIC_DIMENSIONS.map((d) => {
            const s = card.scores[d.id];
            return (
              <tr key={d.id} className="border-t align-top">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {d.name}
                </th>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {s?.score
                    ? `${String(s.score)} · ${SCORE_LABELS[s.score as 1 | 2 | 3 | 4]}`
                    : "—"}
                </td>
                <td className="py-1 whitespace-pre-wrap">{s?.comment ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {card.summary && <p className="whitespace-pre-wrap">{card.summary}</p>}
    </article>
  );
}

function ShareLinks({ api, interviewId }: { api: InterviewApi; interviewId: string }) {
  const queryClient = useQueryClient();
  const key = ["interview-share-links", interviewId];
  const links = useQuery({ queryKey: key, queryFn: () => api.shareLinks(interviewId) });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      const link = await api.createShareLink(interviewId);
      // The token goes in the fragment: browsers never send it to any server or log.
      setCreated(`${window.location.origin}/interviews/${interviewId}#share=${link.token}`);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch {
      setError("Could not create a link.");
    }
  };

  return (
    <Section
      title="Share"
      note="Anyone signed in who has the link can read this summary and the replay (not your notes). The candidate can never open it."
    >
      <Button className="w-fit" variant="outline" onClick={() => void create()}>
        Create link
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {created && (
        <div className="flex items-center gap-2">
          <input
            readOnly
            aria-label="Summary link"
            value={created}
            className="h-8 min-w-0 flex-1 rounded-md border px-2"
            onFocus={(e) => {
              e.target.select();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(created).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 2000);
              });
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      {(links.data ?? []).length > 0 && (
        <ul className="flex flex-col gap-1">
          {(links.data ?? []).map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-2">
              <span>{`Link created ${dateFormat.format(new Date(link.createdAt))}`}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void api
                    .revokeShareLink(interviewId, link.id)
                    .then(() => queryClient.invalidateQueries({ queryKey: key }))
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
