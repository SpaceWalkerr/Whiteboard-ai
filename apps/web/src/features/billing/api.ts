import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  billingSummarySchema,
  catalogResponseSchema,
  changePlanResponseSchema,
  checkoutResponseSchema,
  couponPreviewSchema,
  editorSeatsResponseSchema,
  studentTrialResponseSchema,
  teamResponseSchema,
  type ChangePlanRequest,
  type CheckoutRequest,
  type PlanId,
} from "@whiteboard/shared/billing";
import { useAuth } from "@/auth/authContext";
import type { ApiClient } from "@/lib/apiClient";

const ok = z.unknown();

/** Billing REST calls (apps/server is the only thing that talks to the payment provider). */
export function billingApi(api: ApiClient) {
  return {
    catalog: () => api.request("/billing/plans", { schema: catalogResponseSchema }),
    summary: () => api.request("/billing", { schema: billingSummarySchema }),
    refresh: () =>
      api.request("/billing/refresh", { method: "POST", body: {}, schema: billingSummarySchema }),
    checkout: (body: CheckoutRequest) =>
      api.request("/billing/checkout", { method: "POST", body, schema: checkoutResponseSchema }),
    coupon: (code: string, planId: PlanId) =>
      api.request(`/billing/coupon?${new URLSearchParams({ code, planId }).toString()}`, {
        schema: couponPreviewSchema,
      }),
    cancel: (subscriptionId: string) =>
      api.request("/billing/cancel", {
        method: "POST",
        body: { subscriptionId },
        schema: billingSummarySchema,
      }),
    changePlan: (body: ChangePlanRequest) =>
      api.request("/billing/change-plan", {
        method: "POST",
        body,
        schema: changePlanResponseSchema,
      }),
    studentTrial: () =>
      api.request("/billing/student-trial", {
        method: "POST",
        body: {},
        schema: studentTrialResponseSchema,
      }),
    team: (orgId: string) => api.request(`/teams/${orgId}`, { schema: teamResponseSchema }),
    addTeamMember: (orgId: string, email: string) =>
      api.request(`/teams/${orgId}/members`, { method: "POST", body: { email }, schema: ok }),
    removeTeamMember: (orgId: string, userId: string) =>
      api.send(`/teams/${orgId}/members/${userId}`, { method: "DELETE" }),
    editorSeats: (boardId: string) =>
      api.request(`/boards/${boardId}/editor-seats`, { schema: editorSeatsResponseSchema }),
    releaseSeat: (boardId: string, userId: string) =>
      api.send(`/boards/${boardId}/editor-seats/${userId}`, { method: "DELETE" }),
  };
}

export type BillingApi = ReturnType<typeof billingApi>;

export const BILLING_KEY = ["billing"] as const;

export function useBillingSummary(enabled = true) {
  const { api } = useAuth();
  return useQuery({
    queryKey: BILLING_KEY,
    queryFn: () => billingApi(api).summary(),
    enabled,
  });
}

export function useCatalog() {
  const { api } = useAuth();
  return useQuery({
    queryKey: ["billing", "catalog"],
    queryFn: () => billingApi(api).catalog(),
    staleTime: 10 * 60_000,
  });
}
