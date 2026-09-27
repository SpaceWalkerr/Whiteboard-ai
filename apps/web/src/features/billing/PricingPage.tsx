import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { MIN_TEAM_SEATS, MAX_TEAM_SEATS, type BillingInterval } from "@whiteboard/shared/billing";
import { PLAN_NAMES, STUDENT_TRIAL_MONTHS, type Plan } from "@whiteboard/shared/entitlements";
import { useAuth } from "@/auth/authContext";
import { rememberReturnTo } from "@/auth/localData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/apiClient";
import { cn } from "@/lib/utils";
import { BILLING_KEY, billingApi, useBillingSummary, useCatalog } from "./api";
import { runCheckout } from "./checkout";
import { PlanCards } from "./PlanCards";
import { priceOf } from "./priceOf";
import { usePageTitle } from "@/site/layout/usePageTitle";
import { STATIC_PAGES } from "@/site/meta";

/** /pricing — plans, monthly/yearly, checkout (Razorpay, INR). Works signed out; prerendered. */
export function PricingPage() {
  usePageTitle(STATIC_PAGES["/pricing"].title);
  const { status, api } = useAuth();
  const signedIn = status === "signedIn";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const summary = useBillingSummary(signedIn);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [seats, setSeats] = useState(3);
  const [coupon, setCoupon] = useState("");
  const [couponNote, setCouponNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seatsId = useId();
  const couponId = useId();
  const billing = billingApi(api);
  const plans = catalog.data?.plans ?? [];
  const currentPlan = summary.data?.plan ?? "free";

  const subscribe = async (tier: Plan) => {
    if (!signedIn) {
      rememberReturnTo("/pricing");
      void navigate("/sign-in");
      return;
    }
    const plan = priceOf(plans, tier, interval);
    if (!plan) return;
    setBusy(tier);
    setError(null);
    try {
      const { outcome } = await runCheckout(billing, {
        planId: plan.id,
        ...(tier === "team" ? { seats } : {}),
        ...(coupon.trim() ? { couponCode: coupon.trim().toUpperCase() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: BILLING_KEY });
      if (outcome === "paid") void navigate("/app/settings/billing?welcome=1");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const checkCoupon = async () => {
    const plan = priceOf(plans, "pro", interval);
    if (!coupon.trim() || !plan) return;
    try {
      const preview = await billing.coupon(coupon.trim().toUpperCase(), plan.id);
      setCouponNote(`${preview.code}: ${preview.description}`);
    } catch (caught) {
      setCouponNote(
        caught instanceof ApiRequestError ? caught.message : "Couldn't check that code.",
      );
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Plans</h1>
      <p className="mt-2 text-muted-foreground">
        Start free. Upgrade for unlimited boards, more AI reviews and private rooms. Prices in INR,
        taxes included; cancel any time and keep your plan until the end of the period.
      </p>

      <div
        role="group"
        aria-label="Billing period"
        className="mt-6 inline-flex rounded-md border p-0.5"
      >
        {(["month", "year"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={interval === value}
            onClick={() => {
              setInterval(value);
            }}
            className={cn(
              "rounded px-3 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              interval === value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {value === "month" ? "Monthly" : "Yearly — 2 months free"}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <h2 className="sr-only">Compare plans</h2>
      <div className="mt-6">
        <PlanCards
          plans={plans}
          interval={interval}
          action={(tier, price) => {
            const current = signedIn && currentPlan === tier;
            return (
              <>
                {tier === "team" && (
                  <div className="mb-3">
                    <label htmlFor={seatsId} className="text-sm font-medium">
                      Seats
                    </label>
                    <Input
                      id={seatsId}
                      type="number"
                      min={MIN_TEAM_SEATS}
                      max={MAX_TEAM_SEATS}
                      value={seats}
                      onChange={(e) => {
                        setSeats(
                          Math.min(
                            MAX_TEAM_SEATS,
                            Math.max(MIN_TEAM_SEATS, Number(e.target.value) || MIN_TEAM_SEATS),
                          ),
                        );
                      }}
                    />
                  </div>
                )}
                {tier === "free" ? (
                  <Button variant="outline" className="w-full" asChild>
                    <Link to={signedIn ? "/app" : "/sign-in"}>
                      {signedIn ? "Go to your boards" : "Start free"}
                    </Link>
                  </Button>
                ) : current ? (
                  <Button variant="outline" className="w-full" asChild>
                    <Link to="/app/settings/billing">Your plan — manage</Link>
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    disabled={busy !== null || !price || catalog.data?.checkoutAvailable === false}
                    onClick={() => void subscribe(tier)}
                  >
                    {busy === tier ? "Opening checkout…" : `Get ${PLAN_NAMES[tier]}`}
                  </Button>
                )}
              </>
            );
          }}
        />
      </div>
      {catalog.data?.checkoutAvailable === false && (
        <p className="mt-3 text-sm text-muted-foreground">Payments aren't available right now.</p>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section aria-labelledby="coupon-heading" className="rounded-lg border p-5">
          <h2 id="coupon-heading" className="font-semibold">
            Have a coupon?
          </h2>
          <div className="mt-3 flex gap-2">
            <label htmlFor={couponId} className="sr-only">
              Coupon code
            </label>
            <Input
              id={couponId}
              value={coupon}
              onChange={(e) => {
                setCoupon(e.target.value);
                setCouponNote(null);
              }}
              placeholder="CODE"
              autoComplete="off"
            />
            <Button variant="outline" onClick={() => void checkCoupon()} disabled={!coupon.trim()}>
              Check
            </Button>
          </div>
          <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
            {couponNote ?? "It's applied when you check out."}
          </p>
        </section>
        <section aria-labelledby="student-heading" className="rounded-lg border p-5">
          <h2 id="student-heading" className="font-semibold">
            Students: Pro free for {String(STUDENT_TRIAL_MONTHS)} months
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in with your university email (.edu or .ac.in) and claim it in billing settings. No
            card needed.
          </p>
          <Link
            to={signedIn ? "/app/settings/billing" : "/sign-in"}
            className="mt-3 inline-block text-sm font-medium underline"
          >
            {signedIn ? "Claim the student offer" : "Sign in to claim it"}
          </Link>
        </section>
      </div>
      <p className="mt-8 text-xs text-muted-foreground">
        International customers: USD pricing ($8 Pro, $15 per Team seat) is coming soon. See the{" "}
        <Link to="/refund-policy" className="underline">
          refund & cancellation policy
        </Link>{" "}
        and the{" "}
        <Link to="/docs/billing-faq" className="underline">
          billing FAQ
        </Link>
        .
      </p>
    </div>
  );
}
