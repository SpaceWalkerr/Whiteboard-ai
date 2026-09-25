import { z } from "zod";
import { interviewSummarySchema } from "@whiteboard/graph";
import {
  createdSummaryShareLinkSchema,
  interviewNoteSchema,
  interviewViewResponseSchema,
  interviewViewSchema,
  noteListSchema,
  questionListSchema,
  replayBundleSchema,
  scorecardSchema,
  summaryShareLinkListSchema,
  type InterviewRole,
  type ScorecardInput,
  type StartInterviewRequest,
  type TimerAction,
} from "@whiteboard/shared/interview";
import type { ApiClient } from "@/lib/apiClient";

const viewResponse = z.object({ interview: interviewViewSchema });
const scorecardResponse = z.object({ scorecard: scorecardSchema.nullable() });

/** Interview-mode REST calls. `shareToken` is a board share link or an interview summary link. */
export function interviewApi(api: ApiClient) {
  return {
    questions: async () =>
      (await api.request("/interview-questions", { schema: questionListSchema })).questions,
    current: async (boardId: string, shareToken?: string) =>
      (
        await api.request(`/boards/${boardId}/interview`, {
          schema: interviewViewResponseSchema,
          shareToken,
        })
      ).interview,
    start: async (boardId: string, body: StartInterviewRequest, shareToken?: string) =>
      (
        await api.request(`/boards/${boardId}/interviews`, {
          method: "POST",
          body,
          schema: viewResponse,
          shareToken,
        })
      ).interview,
    setParticipants: async (
      interviewId: string,
      participants: { userId: string; role: InterviewRole }[],
    ) =>
      (
        await api.request(`/interviews/${interviewId}/participants`, {
          method: "PUT",
          body: { participants },
          schema: viewResponse,
        })
      ).interview,
    timer: async (interviewId: string, action: TimerAction) =>
      (
        await api.request(`/interviews/${interviewId}/timer`, {
          method: "POST",
          body: action,
          schema: viewResponse,
        })
      ).interview,
    revealHint: async (interviewId: string, index: number) =>
      (
        await api.request(`/interviews/${interviewId}/hints/${String(index)}/reveal`, {
          method: "POST",
          schema: viewResponse,
        })
      ).interview,
    end: async (interviewId: string) =>
      (
        await api.request(`/interviews/${interviewId}/end`, {
          method: "POST",
          schema: viewResponse,
        })
      ).interview,
    notes: async (interviewId: string) =>
      (await api.request(`/interviews/${interviewId}/notes`, { schema: noteListSchema })).notes,
    addNote: (interviewId: string, body: string) =>
      api.request(`/interviews/${interviewId}/notes`, {
        method: "POST",
        body: { body },
        schema: interviewNoteSchema,
      }),
    editNote: (interviewId: string, noteId: string, body: string) =>
      api.request(`/interviews/${interviewId}/notes/${noteId}`, {
        method: "PATCH",
        body: { body },
        schema: interviewNoteSchema,
      }),
    deleteNote: (interviewId: string, noteId: string) =>
      api.send(`/interviews/${interviewId}/notes/${noteId}`, { method: "DELETE" }),
    scorecard: async (interviewId: string) =>
      (await api.request(`/interviews/${interviewId}/scorecard`, { schema: scorecardResponse }))
        .scorecard,
    saveScorecard: async (interviewId: string, input: ScorecardInput) =>
      (
        await api.request(`/interviews/${interviewId}/scorecard`, {
          method: "PUT",
          body: input,
          schema: scorecardResponse,
        })
      ).scorecard,
    summary: (interviewId: string, shareToken?: string) =>
      api.request(`/interviews/${interviewId}/summary`, {
        schema: interviewSummarySchema,
        shareToken,
      }),
    replay: (interviewId: string, shareToken?: string) =>
      api.request(`/interviews/${interviewId}/replay`, { schema: replayBundleSchema, shareToken }),
    shareLinks: async (interviewId: string) =>
      (
        await api.request(`/interviews/${interviewId}/share-links`, {
          schema: summaryShareLinkListSchema,
        })
      ).links,
    createShareLink: (interviewId: string) =>
      api.request(`/interviews/${interviewId}/share-links`, {
        method: "POST",
        schema: createdSummaryShareLinkSchema,
      }),
    revokeShareLink: (interviewId: string, linkId: string) =>
      api.send(`/interviews/${interviewId}/share-links/${linkId}`, { method: "DELETE" }),
  };
}

export type InterviewApi = ReturnType<typeof interviewApi>;
