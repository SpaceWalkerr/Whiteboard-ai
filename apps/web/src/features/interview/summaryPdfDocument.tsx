import { Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import {
  REVIEW_DIMENSION_LABELS,
  REVIEW_DIMENSIONS,
  type InterviewSummary,
} from "@whiteboard/graph";
import {
  averageScore,
  elapsedMs,
  INTERVIEW_ROLE_NAMES,
  RECOMMENDATION_NAMES,
  RUBRIC_DIMENSIONS,
} from "@whiteboard/shared/interview";
import { sessionClock } from "./replay/clock";

/** The interview summary laid out for PDF (react-pdf primitives, not DOM). */

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", lineHeight: 1.4, color: "#111827" },
  eyebrow: { fontSize: 8, color: "#5b21b6", textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  muted: { color: "#4b5563" },
  h2: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  h3: { fontFamily: "Helvetica-Bold", marginTop: 6, marginBottom: 2 },
  box: { border: "1pt solid #e5e7eb", borderRadius: 4, padding: 8, marginBottom: 6 },
  row: { flexDirection: "row", borderTop: "1pt solid #e5e7eb", paddingVertical: 3 },
  cellName: { width: "32%", paddingRight: 6 },
  cellScore: { width: "12%" },
  cellComment: { width: "56%" },
  scores: { flexDirection: "row", gap: 6, marginVertical: 4 },
  score: { border: "1pt solid #e5e7eb", borderRadius: 4, padding: 4, flexGrow: 1 },
  bullet: { flexDirection: "row", gap: 4 },
});

function Bullets({ items }: { items: string[] }) {
  return (
    <View>
      {items.map((item) => (
        <View key={item} style={styles.bullet}>
          <Text>•</Text>
          <Text style={{ flex: 1 }}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export function SummaryPages({
  summary,
  board,
  now,
}: {
  summary: InterviewSummary;
  board: { src: string; width: number; height: number } | null;
  /** For an interview still in progress: measured up to this moment. */
  now: number;
}) {
  const review = summary.reviews[0]?.review ?? null;
  const duration = elapsedMs(summary.timer, summary.timer.endedAt ?? now);
  const pageWidth = 595 - 72; // A4 width minus padding, in points
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.eyebrow}>Interview summary</Text>
      <Text style={styles.title}>{summary.question.title}</Text>
      <Text style={styles.muted}>
        {`${new Date(summary.timer.startedAt).toLocaleString()} · ${sessionClock(duration)} long`}
      </Text>
      <Text style={styles.muted}>
        {summary.participants
          .map((p) => `${p.name} (${INTERVIEW_ROLE_NAMES[p.role].toLowerCase()})`)
          .join(" · ")}
      </Text>

      <Text style={styles.h2}>Question</Text>
      <Text>{summary.question.prompt}</Text>
      <Text style={styles.h3}>Functional requirements</Text>
      <Bullets items={summary.question.requirements.functional} />
      <Text style={styles.h3}>Non-functional requirements</Text>
      <Bullets items={summary.question.requirements.nonFunctional} />
      <Text style={styles.h3}>Hints given</Text>
      {summary.revealedHints.length === 0 ? (
        <Text style={styles.muted}>None</Text>
      ) : (
        <Bullets items={summary.revealedHints.flatMap((i) => summary.question.hints[i] ?? [])} />
      )}

      {board && (
        <View wrap={false}>
          <Text style={styles.h2}>Final board</Text>
          <Image
            src={board.src}
            style={{
              width: Math.min(pageWidth, board.width),
              height: (Math.min(pageWidth, board.width) / board.width) * board.height,
              maxHeight: 420,
              objectFit: "contain",
            }}
          />
        </View>
      )}

      <Text style={styles.h2}>AI design review</Text>
      {review ? (
        <View>
          <Text>{review.summary}</Text>
          <View style={styles.scores}>
            {REVIEW_DIMENSIONS.map((d) => (
              <View key={d} style={styles.score}>
                <Text style={styles.muted}>{REVIEW_DIMENSION_LABELS[d]}</Text>
                <Text
                  style={{ fontFamily: "Helvetica-Bold" }}
                >{`${String(review.scores[d])}/10`}</Text>
              </View>
            ))}
          </View>
          {review.findings.map((finding, i) => (
            <View key={finding.id} style={styles.box} wrap={false}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>
                {`${String(i + 1)}. [${finding.severity}] ${finding.title}`}
              </Text>
              <Text>{finding.explanation}</Text>
              <Text style={styles.muted}>{`Fix: ${finding.suggestion}`}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>No AI review was run during this interview.</Text>
      )}

      <Text style={styles.h2}>Scorecards</Text>
      {summary.scorecards.length === 0 && <Text style={styles.muted}>No scorecards yet.</Text>}
      {summary.scorecards.map((card) => {
        const average = averageScore(card.scores);
        return (
          <View key={card.interviewerId} style={styles.box} wrap={false}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>
              {`${card.interviewerName}${card.submittedAt ? "" : " (draft)"}`}
            </Text>
            <Text>
              {`Recommendation: ${card.recommendation ? RECOMMENDATION_NAMES[card.recommendation] : "—"}${
                average !== null ? ` · average ${String(average)}/4` : ""
              }`}
            </Text>
            {RUBRIC_DIMENSIONS.map((d) => {
              const s = card.scores[d.id];
              return (
                <View key={d.id} style={styles.row}>
                  <Text style={styles.cellName}>{d.name}</Text>
                  <Text style={styles.cellScore}>{s?.score ? `${String(s.score)}/4` : "—"}</Text>
                  <Text style={styles.cellComment}>{s?.comment ?? ""}</Text>
                </View>
              );
            })}
            {card.summary ? <Text style={{ marginTop: 4 }}>{card.summary}</Text> : null}
          </View>
        );
      })}

      {summary.notes && summary.notes.length > 0 && (
        <View>
          <Text style={styles.h2}>Interviewer notes (confidential)</Text>
          {summary.notes.map((note) => (
            <View key={note.id} style={styles.box} wrap={false}>
              <Text style={styles.muted}>
                {`${sessionClock(Date.parse(note.createdAt) - summary.timer.startedAt)} · ${note.authorName}`}
              </Text>
              <Text>{note.body}</Text>
            </View>
          ))}
        </View>
      )}
    </Page>
  );
}
