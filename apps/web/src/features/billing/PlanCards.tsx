import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { formatMoney, type BillingInterval, type CatalogPlan } from "@whiteboard/shared/billing";
import { PLAN_NAMES, PLANS, type Plan } from "@whiteboard/shared/entitlements";
import { cn } from "@/lib/utils";
import { FEATURE_ROWS } from "./features";
import { priceOf } from "./priceOf";

function FeatureValue({ value }: { value: string | boolean }) {
  if (value === true) return <Check className="size-4" aria-label="Included" />;
  if (value === false)
    return <Minus className="size-4 text-muted-foreground" aria-label="Not included" />;
  return <span>{value}</span>;
}

/**
 * One card per plan: price from the plans catalog (the `plans` table, via GET /billing/plans)
 * and limits from the shared entitlements table. Used by /pricing and the landing page, which
 * pass their own call to action. A missing price shows "—" (catalog not loaded yet).
 */
export function PlanCards({
  plans,
  interval,
  action,
}: {
  plans: readonly CatalogPlan[];
  interval: BillingInterval;
  action: (tier: Plan, price: CatalogPlan | undefined) => ReactNode;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PLANS.map((tier) => {
        const price = tier === "free" ? undefined : priceOf(plans, tier, interval);
        return (
          <section
            key={tier}
            aria-labelledby={`plan-${tier}`}
            className={cn(
              "flex flex-col rounded-lg border p-5",
              tier === "pro" && "border-primary",
            )}
          >
            <h3 id={`plan-${tier}`} className="text-lg font-semibold">
              {PLAN_NAMES[tier]}
            </h3>
            <p className="mt-1 text-2xl font-semibold">
              {tier === "free"
                ? "₹0"
                : price
                  ? formatMoney(price.amountMinor, price.currency)
                  : "—"}
              <span className="text-sm font-normal text-muted-foreground">
                {tier === "free"
                  ? " forever"
                  : `${tier === "team" ? " per seat" : ""} / ${interval}`}
              </span>
            </p>
            <ul className="mt-4 grid gap-2 text-sm">
              {FEATURE_ROWS.map((row) => (
                <li key={row.label} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{row.label}</span>
                  <FeatureValue value={row.value(tier)} />
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-5">{action(tier, price)}</div>
          </section>
        );
      })}
    </div>
  );
}
