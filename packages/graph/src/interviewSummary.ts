import { z } from "zod";
import { interviewSummaryBaseSchema } from "@whiteboard/shared/interview";
import { reviewRecordSchema } from "./review";

/**
 * GET /interviews/:id/summary. Lives here (not in @whiteboard/shared) because it embeds the
 * AI review records, whose schema this package owns.
 */
export const interviewSummarySchema = interviewSummaryBaseSchema.extend({
  /** Reviews run during the interview, newest first. */
  reviews: z.array(reviewRecordSchema),
});
export type InterviewSummary = z.infer<typeof interviewSummarySchema>;
