import { Check, Minus } from "lucide-react";
import { PLAN_LIMITS, PLAN_NAMES, PLANS } from "@whiteboard/shared/plans";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Monthly prices from SPEC.md, for the comparison only (billing arrives in Phase 10). */
const PRICES = { free: "Free", pro: "₹399 · $8 / month", team: "₹999 · $15 / seat / month" };

/**
 * Shown when the server refuses with 402 (monthly AI reviews used up, or a Pro feature on
 * Free). Plans can't be bought yet, so it explains the plans and says upgrades are coming.
 */
export function UpgradeDialog({
  message,
  onOpenChange,
}: {
  message: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={message !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upgrade for more AI reviews</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <table className="w-full text-sm">
          <caption className="sr-only">Plan comparison</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 font-medium">
                Plan
              </th>
              <th scope="col" className="py-2 font-medium">
                AI reviews / month
              </th>
              <th scope="col" className="py-2 font-medium">
                Live hints
              </th>
            </tr>
          </thead>
          <tbody>
            {PLANS.map((plan) => (
              <tr key={plan} className="border-b last:border-0">
                <th scope="row" className="py-2 text-left font-medium">
                  {PLAN_NAMES[plan]}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {PRICES[plan]}
                  </span>
                </th>
                <td className="py-2">
                  {plan === "team"
                    ? `${String(PLAN_LIMITS[plan].aiReviewsPerMonth)} per seat`
                    : PLAN_LIMITS[plan].aiReviewsPerMonth}
                </td>
                <td className="py-2">
                  {PLAN_LIMITS[plan].liveHints ? (
                    <Check className="size-4" aria-label="Included" />
                  ) : (
                    <Minus className="size-4" aria-label="Not included" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">
          Paid plans are coming soon. Your free allowance resets at the start of each month.
        </p>
        <div className="flex justify-end gap-2">
          <Button disabled title="Paid plans are coming soon">
            Upgrade — coming soon
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
