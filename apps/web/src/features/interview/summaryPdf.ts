import { Document, pdf } from "@react-pdf/renderer";
import { createElement } from "react";
import type { InterviewSummary } from "@whiteboard/graph";
import { BoardStore } from "@whiteboard/shared/board";
import type { ReplayBundle } from "@whiteboard/shared/interview";
import { boardToPng, triggerDownload } from "@/features/board/export/download";
import { timelineFromBundle } from "./replay/bundle";
import { SummaryPages } from "./summaryPdfDocument";

/**
 * The summary as a PDF, generated in the browser (this module and react-pdf are loaded only
 * when someone clicks "Export PDF"). Contains exactly what the viewer sees on the summary
 * page, plus a picture of the board as it was when the interview ended.
 */
export async function exportSummaryPdf(
  summary: InterviewSummary,
  loadReplay: () => Promise<ReplayBundle>,
  now: number,
): Promise<void> {
  const board = await finalBoardImage(await loadReplay());
  const document = createElement(
    Document,
    { title: `Interview summary — ${summary.question.title}`, creator: "Whiteboard.ai" },
    createElement(SummaryPages, { summary, board, now }),
  );
  const blob = await pdf(document).toBlob();
  const slug = summary.question.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const date = new Date(summary.timer.startedAt).toISOString().slice(0, 10);
  triggerDownload(blob, `interview-${slug}-${date}.pdf`);
}

async function finalBoardImage(
  bundle: ReplayBundle,
): Promise<{ src: string; width: number; height: number } | null> {
  const timeline = timelineFromBundle(bundle);
  const doc = timeline.docAt(timeline.end);
  const store = new BoardStore({ doc });
  try {
    const png = await boardToPng(store.getSnapshot().ordered, 2);
    if (!png) return null;
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("could not read the board image"));
      };
      reader.onerror = () => {
        reject(new Error("could not read the board image"));
      };
      reader.readAsDataURL(png.blob);
    });
    return { src, width: png.width, height: png.height };
  } finally {
    store.destroy();
    doc.destroy();
  }
}
