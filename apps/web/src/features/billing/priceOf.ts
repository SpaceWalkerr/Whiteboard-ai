import type { BillingInterval, CatalogPlan } from "@whiteboard/shared/billing";
import type { Plan } from "@whiteboard/shared/entitlements";

/** The catalog price for a paid tier at a billing interval, if the catalog has one. */
export function priceOf(plans: readonly CatalogPlan[], tier: Plan, interval: BillingInterval) {
  return plans.find((p) => p.tier === tier && p.interval === interval);
}
