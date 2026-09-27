import { Check, Minus } from "lucide-react";
import { Link } from "react-router";
import { PLAN_NAMES, PLANS, type LimitCode } from "@whiteboard/shared/entitlements";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FEATURE_ROWS } from "@/features/billing/features";

const TITLES: Record<LimitCode, string> = {
  QUOTA_EXCEEDED: "Upgrade for more AI reviews",
  BOARD_LIMIT: "Upgrade for unlimited boards",
  EDITOR_LIMIT: "This board has reached its editor limit",
  BOARD_LOCKED: "This board is read-only on your plan",
  PLAN_REQUIRED: "Upgrade to unlock this",
};

/**
 * The upgrade prompt shown at every plan limit (the server answered 402 with one of the
 * shared limit codes): explains what happened, compares plans, links to checkout.
 */
export function UpgradeDialog({
  message,
  code = "QUOTA_EXCEEDED",
  onOpenChange,
}: {
  message: string | null;
  code?: LimitCode;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={message !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLES[code]}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <table className="w-full text-sm">
          <caption className="sr-only">Plan comparison</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Feature</span>
              </th>
              {PLANS.map((plan) => (
                <th key={plan} scope="col" className="py-2 font-medium">
                  {PLAN_NAMES[plan]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURE_ROWS.map((row) => (
              <tr key={row.label} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">
                  {row.label}
                </th>
                {PLANS.map((plan) => {
                  const value = row.value(plan);
                  return (
                    <td key={plan} className="py-2">
                      {value === true ? (
                        <Check className="size-4" aria-label="Included" />
                      ) : value === false ? (
                        <Minus className="size-4" aria-label="Not included" />
                      ) : (
                        value
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end gap-2">
          <Button asChild>
            <Link to="/pricing">See plans and upgrade</Link>
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
