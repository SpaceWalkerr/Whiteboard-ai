import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  formatMoney,
  MAX_TEAM_SEATS,
  type BillingSummary,
  type SubscriptionSummary,
} from "@whiteboard/shared/billing";
import { PLAN_NAMES } from "@whiteboard/shared/entitlements";
import { useAuth } from "@/auth/authContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/apiClient";
import { BILLING_KEY, billingApi, useBillingSummary } from "./api";

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

const STATUS_TEXT: Record<SubscriptionSummary["status"], string> = {
  created: "Waiting for payment",
  authenticated: "Starting",
  active: "Active",
  past_due: "Payment failed — retrying",
  halted: "Payment failed",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Ended",
  expired: "Not completed",
};

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

/** /app/settings/billing — plan, usage, subscriptions, invoices, student offer, team seats. */
export function BillingSettingsPage() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const summary = useBillingSummary();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const billing = billingApi(api);
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: BILLING_KEY });
    await queryClient.invalidateQueries({ queryKey: ["boards"] });
    await queryClient.invalidateQueries({ queryKey: ["ai-quota"] });
  };
  const trial = useMutation({
    mutationFn: () => billing.studentTrial(),
    onSuccess: refreshAll,
    onError: (e) => {
      setError(errorText(e));
    },
  });

  if (summary.isPending) return <Shell>Loading billing…</Shell>;
  if (summary.isError) return <Shell>{errorText(summary.error)}</Shell>;
  const data = summary.data;

  return (
    <Shell>
      {params.get("welcome") && data.plan !== "free" && (
        <p role="status" className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm">
          Thank you! Your {PLAN_NAMES[data.plan]} plan is active.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <section aria-labelledby="plan-heading" className="rounded-lg border p-5">
        <h2 id="plan-heading" className="text-lg font-semibold">
          Your plan: {PLAN_NAMES[data.plan]}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{planSource(data)}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat
            label="Boards"
            value={`${String(data.usage.boards)} of ${data.usage.boardLimit === null ? "unlimited" : String(data.usage.boardLimit)}`}
          />
          <Stat label="Read-only boards" value={String(data.usage.lockedBoards)} />
          <Stat
            label="AI reviews this month"
            value={`${String(data.usage.aiReviewsUsed)} of ${String(data.usage.aiReviewsLimit)}`}
          />
          <Stat label="Editors per board" value={String(data.usage.editorsPerBoard)} />
        </dl>
        {data.usage.lockedBoards > 0 && (
          <p className="mt-3 text-sm">
            {String(data.usage.lockedBoards)} of your boards are read-only because they're above
            your plan's limit. Nothing was deleted: upgrade, or move boards to the trash, to edit
            them again.
          </p>
        )}
        <Link to="/pricing" className="mt-4 inline-block text-sm font-medium underline">
          Compare plans
        </Link>
      </section>

      {data.subscriptions.map((sub) => (
        <SubscriptionCard key={sub.id} sub={sub} onChanged={refreshAll} onError={setError} />
      ))}

      {(data.studentTrial.eligible || data.studentTrial.activeUntil) && (
        <section aria-labelledby="student-heading" className="mt-6 rounded-lg border p-5">
          <h2 id="student-heading" className="font-semibold">
            Student offer
          </h2>
          {data.studentTrial.activeUntil ? (
            <p className="mt-2 text-sm">Pro is free until {date(data.studentTrial.activeUntil)}.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Your university email qualifies for 3 months of Pro, free. No card needed.
              </p>
              <Button
                className="mt-3"
                disabled={trial.isPending}
                onClick={() => {
                  trial.mutate();
                }}
              >
                Claim 3 months of Pro
              </Button>
            </>
          )}
        </section>
      )}

      {data.teams.map((team) => (
        <TeamSection
          key={team.orgId}
          orgId={team.orgId}
          onError={setError}
          onChanged={refreshAll}
        />
      ))}

      <section aria-labelledby="invoices-heading" className="mt-6 rounded-lg border p-5">
        <h2 id="invoices-heading" className="font-semibold">
          Invoices
        </h2>
        {data.invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">Invoices</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 font-medium">
                  Period
                </th>
                <th scope="col" className="py-2 font-medium">
                  Amount
                </th>
                <th scope="col" className="py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Receipt</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b last:border-0">
                  <td className="py-2">{date(invoice.paidAt ?? invoice.issuedAt)}</td>
                  <td className="py-2">
                    {date(invoice.periodStart)} – {date(invoice.periodEnd)}
                  </td>
                  <td className="py-2">{formatMoney(invoice.amountMinor, invoice.currency)}</td>
                  <td className="py-2 capitalize">{invoice.status}</td>
                  <td className="py-2 text-right">
                    {invoice.receiptUrl && (
                      <a
                        href={invoice.receiptUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Receipt
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Shell>
  );
}

function planSource(data: BillingSummary): string {
  switch (data.source) {
    case "free":
      return "Free forever. Upgrade any time.";
    case "student_trial":
      return `Student offer until ${date(data.validUntil)}.`;
    case "team_seat":
      return data.validUntil
        ? `Team seat until ${date(data.validUntil)}.`
        : "You have a seat in a team.";
    case "manual":
      return "Set by support.";
    case "subscription":
      return data.validUntil ? `Paid until ${date(data.validUntil)}.` : "Renews automatically.";
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link to="/app" className="font-semibold">
          Whiteboard.ai
        </Link>
        <Link to="/app" className="text-sm font-medium underline">
          Back to your boards
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Billing</h1>
        {children}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function SubscriptionCard({
  sub,
  onChanged,
  onError,
}: {
  sub: SubscriptionSummary;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { api } = useAuth();
  const billing = billingApi(api);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [seats, setSeats] = useState(sub.seats);
  const [notice, setNotice] = useState<string | null>(null);
  const seatsId = useId();
  const team = sub.tier === "team";
  const renewing =
    (sub.status === "active" || sub.status === "authenticated") && !sub.cancelAtPeriodEnd;
  const otherInterval = sub.planId.endsWith("_monthly")
    ? (sub.planId.replace("_monthly", "_yearly") as typeof sub.planId)
    : (sub.planId.replace("_yearly", "_monthly") as typeof sub.planId);

  const cancel = useMutation({
    mutationFn: () => billing.cancel(sub.id),
    onSuccess: async () => {
      setConfirmCancel(false);
      await onChanged();
    },
    onError: (e) => {
      onError(errorText(e));
    },
  });
  const change = useMutation({
    mutationFn: (body: { planId: typeof sub.planId; seats?: number }) =>
      billing.changePlan({ subscriptionId: sub.id, ...body }),
    onSuccess: async (result) => {
      setNotice(
        result.effective === "now"
          ? "Changed. It applies now."
          : "Scheduled: the change applies at the end of the current period.",
      );
      await onChanged();
    },
    onError: (e) => {
      onError(errorText(e));
    },
  });

  return (
    <section
      aria-label={`${PLAN_NAMES[sub.tier]} subscription`}
      className="mt-6 rounded-lg border p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">
            {PLAN_NAMES[sub.tier]} {sub.planId.endsWith("_yearly") ? "(yearly)" : "(monthly)"}
            {team && ` · ${String(sub.seats)} seats`}
            {sub.orgName && team && (
              <span className="font-normal text-muted-foreground"> · {sub.orgName}</span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">{STATUS_TEXT[sub.status]}</p>
        </div>
      </div>
      {(sub.status === "past_due" || sub.status === "halted") && sub.graceUntil && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
        >
          Your last payment didn't go through. You keep {PLAN_NAMES[sub.tier]} until{" "}
          {date(sub.graceUntil)}; after that your account moves to Free (nothing is deleted).
          Razorpay retries automatically — check your card or UPI mandate.
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <Stat
          label={sub.cancelAtPeriodEnd ? "Ends on" : "Current period ends"}
          value={date(sub.currentPeriodEnd)}
        />
        <Stat
          label="Next charge"
          value={
            sub.nextChargeAt && sub.nextChargeMinor !== null
              ? `${formatMoney(sub.nextChargeMinor, sub.currency)} on ${date(sub.nextChargeAt)}`
              : "None"
          }
        />
      </dl>
      {sub.cancelAtPeriodEnd && (
        <p className="mt-3 text-sm">
          Cancelled. You keep {PLAN_NAMES[sub.tier]} until {date(sub.currentPeriodEnd)}; you won't
          be charged again.
        </p>
      )}
      {sub.scheduledChange && (
        <p className="mt-3 text-sm">A plan change is scheduled for the end of this period.</p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      {sub.canManage && renewing && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          {team && (
            <div>
              <label htmlFor={seatsId} className="block text-sm font-medium">
                Seats
              </label>
              <Input
                id={seatsId}
                type="number"
                min={2}
                max={MAX_TEAM_SEATS}
                value={seats}
                className="w-24"
                onChange={(e) => {
                  setSeats(Number(e.target.value) || sub.seats);
                }}
              />
            </div>
          )}
          {team && (
            <Button
              variant="outline"
              disabled={change.isPending || seats === sub.seats}
              onClick={() => {
                change.mutate({ planId: sub.planId, seats });
              }}
            >
              Update seats
            </Button>
          )}
          <Button
            variant="outline"
            disabled={change.isPending}
            onClick={() => {
              change.mutate({ planId: otherInterval, ...(team ? { seats: sub.seats } : {}) });
            }}
          >
            Switch to {otherInterval.endsWith("_yearly") ? "yearly (2 months free)" : "monthly"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setConfirmCancel(true);
            }}
          >
            Cancel subscription
          </Button>
        </div>
      )}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {PLAN_NAMES[sub.tier]}?</DialogTitle>
            <DialogDescription>
              You keep {PLAN_NAMES[sub.tier]} until {date(sub.currentPeriodEnd)} and won't be
              charged again. After that your account moves to Free: boards above the Free limit
              become read-only. Nothing is deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              Keep my plan
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              Cancel subscription
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TeamSection({
  orgId,
  onChanged,
  onError,
}: {
  orgId: string;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { api } = useAuth();
  const billing = billingApi(api);
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ["team", orgId], queryFn: () => billing.team(orgId) });
  const [email, setEmail] = useState("");
  const emailId = useId();
  const after = async () => {
    await queryClient.invalidateQueries({ queryKey: ["team", orgId] });
    await onChanged();
  };
  const add = useMutation({
    mutationFn: () => billing.addTeamMember(orgId, email.trim()),
    onSuccess: async () => {
      setEmail("");
      await after();
    },
    onError: (e) => {
      onError(errorText(e));
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => billing.removeTeamMember(orgId, userId),
    onSuccess: after,
    onError: (e) => {
      onError(errorText(e));
    },
  });
  if (!team.data) return null;
  const t = team.data;
  return (
    <section aria-labelledby={`team-${orgId}`} className="mt-6 rounded-lg border p-5">
      <h2 id={`team-${orgId}`} className="font-semibold">
        Team: {t.name}
      </h2>
      <p className="text-sm text-muted-foreground">
        {String(t.members.length)} of {String(t.seats)} seats used. Members get every Team feature
        and can edit the team's boards.
      </p>
      <ul className="mt-3 grid gap-2 text-sm">
        {t.members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-2">
            <span>
              {m.displayName} <span className="text-muted-foreground">{m.email}</span>
              {m.role !== "member" && <span className="ml-1 text-xs">({m.role})</span>}
              {!m.hasSeat && <span className="ml-1 text-xs text-amber-700">no seat</span>}
            </span>
            {t.canManage && m.role !== "owner" && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${m.displayName} from the team`}
                onClick={() => {
                  remove.mutate(m.userId);
                }}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {t.canManage && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) add.mutate();
          }}
        >
          <label htmlFor={emailId} className="sr-only">
            Email of the person to add
          </label>
          <Input
            id={emailId}
            type="email"
            value={email}
            placeholder="teammate@company.com"
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <Button type="submit" disabled={add.isPending || t.members.length >= t.seats}>
            Add member
          </Button>
        </form>
      )}
    </section>
  );
}
