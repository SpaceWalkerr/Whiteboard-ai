import { Lock, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** "End-to-end encrypted" badge for the board header, with what that means on hover/focus. */
export function PrivateBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Lock aria-hidden="true" className="size-3" />
          End-to-end encrypted
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Only people with the key (in the link) can read this board — not even our servers.
        Thumbnails, search, duplicating, live hints and interviews are off for it.
      </TooltipContent>
    </Tooltip>
  );
}

/** The one thing to understand about private boards. */
export function KeyWarning() {
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        The key is only in the link (after <code>#key=</code>). We can&apos;t recover it: if every
        copy of the link is lost, so is the board. Share it only with people who should read the
        board.
      </span>
    </p>
  );
}
