import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type {
  BillingSummary,
  CatalogResponse,
  CheckoutResponse,
  SubscriptionSummary,
} from "@whiteboard/shared/billing";
import { AuthContext, type AuthState } from "@/auth/authContext";
import type { ApiClient } from "@/lib/apiClient";
import type { BillingApi } from "../api";
import { BillingSettingsPage } from "../BillingSettingsPage";
import { runCheckout } from "../checkout";
import { PricingPage } from "../PricingPage";

const SUB_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: "free",
    source: "free",
    validUntil: null,
    subscriptions: [],
    invoices: [],
    usage: {
      boards: 3,
      boardLimit: 3,
      lockedBoards: 0,
      aiReviewsUsed: 1,
      aiReviewsLimit: 5,
      editorsPerBoard: 3,
    },
    studentTrial: { eligible: false, activeUntil: null },
    teams: [],
    checkoutAvailable: true,
    ...overrides,
  };
}

function subscription(overrides: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
  return {
    id: SUB_ID,
    orgId: null,
    orgName: null,
    planId: "pro_monthly",
    tier: "pro",
    status: "active",
    seats: 1,
    currentPeriodEnd: "2026-10-27T00:00:00.000Z",
    nextChargeAt: "2026-10-27T00:00:00.000Z",
    nextChargeMinor: 39900,
    currency: "INR",
    cancelAtPeriodEnd: false,
    graceUntil: null,
    canManage: true,
    scheduledChange: false,
    ...overrides,
  };
}

const CATALOG: CatalogResponse = {
  checkoutAvailable: true,
  plans: [
    {
      id: "pro_monthly",
      tier: "pro",
      interval: "month",
      currency: "INR",
      amountMinor: 39900,
      perSeat: false,
    },
    {
      id: "pro_yearly",
      tier: "pro",
      interval: "year",
      currency: "INR",
      amountMinor: 399000,
      perSeat: false,
    },
    {
      id: "team_monthly",
      tier: "team",
      interval: "month",
      currency: "INR",
      amountMinor: 99900,
      perSeat: true,
    },
    {
      id: "team_yearly",
      tier: "team",
      interval: "year",
      currency: "INR",
      amountMinor: 999000,
      perSeat: true,
    },
  ],
};

/** A fake API answering by path; records every call. */
function fakeApi(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const handle = (path: string, method: string, body: unknown) => {
    calls.push({ path, method, body });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return Promise.reject(new Error(`unexpected ${path}`));
    const handler = routes[key];
    return Promise.resolve(handler ? handler(body) : null);
  };
  const api = {
    request: (path: string, options: { method?: string; body?: unknown }) =>
      handle(path, options.method ?? "GET", options.body),
    send: (path: string, options: { method: string; body?: unknown }) =>
      handle(path, options.method, options.body).then(() => undefined),
  } as unknown as ApiClient;
  return { api, calls };
}

function wrap(
  api: ApiClient,
  children: ReactNode,
  status: AuthState["status"] = "signedIn",
  path = "/",
) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuthContext.Provider value={{ api, status } as unknown as AuthState}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/sign-in" element={<p>Sign-in page</p>} />
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

describe("runCheckout", () => {
  const checkout: CheckoutResponse = {
    provider: "razorpay",
    subscriptionId: SUB_ID,
    razorpay: { keyId: "rzp_test_x", subscriptionId: "sub_1" },
    prefill: { email: null, name: null },
    description: "Pro",
  };

  it("asks the server to fetch the result after payment, until the subscription is live", async () => {
    const refresh = vi
      .fn<BillingApi["refresh"]>()
      .mockResolvedValueOnce(summary({ subscriptions: [subscription({ status: "created" })] }))
      .mockResolvedValueOnce(summary({ plan: "pro", subscriptions: [subscription()] }));
    const billing = {
      checkout: vi.fn().mockResolvedValue(checkout),
      refresh,
    } as unknown as BillingApi;
    const wait = vi.fn(() => Promise.resolve());
    const result = await runCheckout(
      billing,
      { planId: "pro_monthly" },
      () => Promise.resolve("paid"),
      wait,
    );
    expect(result.outcome).toBe("paid");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.summary?.plan).toBe("pro");
  });

  it("does nothing more when the customer closes the checkout", async () => {
    const refresh = vi.fn();
    const billing = {
      checkout: vi.fn().mockResolvedValue(checkout),
      refresh,
    } as unknown as BillingApi;
    const result = await runCheckout(billing, { planId: "pro_monthly" }, () =>
      Promise.resolve("dismissed"),
    );
    expect(result).toEqual({ outcome: "dismissed", summary: null });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("PricingPage", () => {
  it("shows prices and plan limits, and sends signed-out visitors to sign in", async () => {
    const { api } = fakeApi({ "/billing/plans": () => CATALOG });
    render(wrap(api, <PricingPage />, "signedOut"));
    const pro = await screen.findByRole("region", { name: "Pro" });
    await waitFor(() => {
      expect(pro).toHaveTextContent("₹399");
    });
    expect(within(pro).getByText("Unlimited")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yearly — 2 months free" }));
    expect(pro).toHaveTextContent("₹3,990");
    await userEvent.click(within(pro).getByRole("button", { name: "Get Pro" }));
    expect(await screen.findByText("Sign-in page")).toBeInTheDocument();
  });
});

describe("BillingSettingsPage", () => {
  it("shows the plan, next charge and invoices, and cancels only after confirming", async () => {
    let current = summary({
      plan: "pro",
      source: "subscription",
      subscriptions: [subscription()],
      invoices: [
        {
          id: "5b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
          status: "paid",
          amountMinor: 39900,
          currency: "INR",
          issuedAt: "2026-09-27T00:00:00.000Z",
          paidAt: "2026-09-27T00:00:00.000Z",
          periodStart: "2026-09-27T00:00:00.000Z",
          periodEnd: "2026-10-27T00:00:00.000Z",
          receiptUrl: "https://rzp.example/i",
        },
      ],
    });
    const { api, calls } = fakeApi({
      "/billing/cancel": () => {
        current = summary({
          plan: "pro",
          subscriptions: [
            subscription({ cancelAtPeriodEnd: true, nextChargeAt: null, nextChargeMinor: null }),
          ],
        });
        return current;
      },
      "/billing": () => current,
    });
    render(wrap(api, <BillingSettingsPage />));
    expect(await screen.findByRole("heading", { name: "Your plan: Pro" })).toBeInTheDocument();
    const sub = screen.getByRole("region", { name: "Pro subscription" });
    expect(sub).toHaveTextContent("₹399 on");
    expect(screen.getByRole("table", { name: "Invoices" })).toHaveTextContent("₹399");
    expect(screen.getByRole("link", { name: "Receipt" })).toHaveAttribute(
      "href",
      "https://rzp.example/i",
    );

    await userEvent.click(within(sub).getByRole("button", { name: "Cancel subscription" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel Pro?" });
    expect(calls.some((c) => c.path === "/billing/cancel")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
    expect(calls.find((c) => c.path === "/billing/cancel")?.body).toEqual({
      subscriptionId: SUB_ID,
    });
    expect(await screen.findByText(/you won't be charged again/)).toBeInTheDocument();
  });

  it("warns during the grace period and explains read-only boards", async () => {
    const { api } = fakeApi({
      "/billing": () =>
        summary({
          plan: "pro",
          subscriptions: [
            subscription({ status: "past_due", graceUntil: "2026-10-04T00:00:00.000Z" }),
          ],
          usage: { ...summary().usage, lockedBoards: 2 },
        }),
    });
    render(wrap(api, <BillingSettingsPage />));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your last payment didn't go through",
    );
    expect(screen.getByText(/2 of your boards are read-only/)).toBeInTheDocument();
  });

  it("offers the student trial to eligible users", async () => {
    let claimed = false;
    const { api, calls } = fakeApi({
      "/billing/student-trial": () => {
        claimed = true;
        return { activeUntil: "2026-12-27T00:00:00.000Z" };
      },
      "/billing": () =>
        summary({
          studentTrial: claimed
            ? { eligible: false, activeUntil: "2026-12-27T00:00:00.000Z" }
            : { eligible: true, activeUntil: null },
        }),
    });
    render(wrap(api, <BillingSettingsPage />));
    await userEvent.click(await screen.findByRole("button", { name: "Claim 3 months of Pro" }));
    expect(calls.some((c) => c.path === "/billing/student-trial" && c.method === "POST")).toBe(
      true,
    );
    expect(await screen.findByText(/Pro is free until/)).toBeInTheDocument();
  });
});
