import { RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { SEVERITIES, type Finding, type IgnoredShape } from "@whiteboard/graph";
import type { BoardStore } from "@whiteboard/shared/board";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CheckFocus, DesignCheckStore } from "../check/DesignCheckStore";
import { IGNORED_REASON_TEXT, SEVERITY_META } from "../check/severity";
import { shapeText } from "../model/defaults";
import { shapeTypeLabel } from "../model/systemShapes";
import { IconButton } from "./IconButton";

/** Long ignored lists (e.g. a board full of sticky notes) are cut here. */
const MAX_IGNORED_LISTED = 50;

interface FindingsPanelProps {
  check: DesignCheckStore;
  store: BoardStore;
  onRecheck: () => void;
  onClose: () => void;
  /** Highlight and zoom to these shapes. */
  onFocus: (focus: CheckFocus) => void;
}

function summary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No obvious problems found";
  return SEVERITIES.flatMap((severity) => {
    const count = findings.filter((f) => f.severity === severity).length;
    if (count === 0) return [];
    const meta = SEVERITY_META[severity];
    return [`${String(count)} ${count === 1 ? meta.label.toLowerCase() : meta.plural}`];
  }).join(" · ");
}

/** Results of the rule-based design check, next to the canvas. */
export function FindingsPanel({ check, store, onRecheck, onClose, onFocus }: FindingsPanelProps) {
  const state = useSyncExternalStore(check.subscribe, check.get);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Keyboard and screen-reader users land on the results when the panel opens.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape inside the panel closes it. Stopped here so the board's own Escape handling
  // (clear selection) doesn't also run.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const result = state.result;
  if (!state.open || !result) return null;
  const stale = check.isStale(snapshot);
  const findings = result.findings;

  const describe = (item: IgnoredShape) => {
    const shape = item.shapeId === null ? undefined : snapshot.shapes.get(item.shapeId);
    if (!shape) return item.shapeType ?? "Unknown shape";
    const text = shapeText(shape)?.trim() ?? "";
    const short = text.length > 32 ? `${text.slice(0, 31)}…` : text;
    return short ? `${shapeTypeLabel(shape)} “${short}”` : shapeTypeLabel(shape);
  };
  const ignored = result.graph.ignored.filter((item) => item.shapeId !== null);

  return (
    <aside
      ref={panelRef}
      aria-labelledby={headingId}
      className="absolute top-16 right-3 z-20 flex max-h-[calc(100%-5rem)] w-80 flex-col rounded-lg border bg-background text-sm shadow-sm"
    >
      <div className="flex items-center gap-1 border-b py-1 pr-1 pl-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="flex-1 font-semibold outline-none"
        >
          Design check
        </h2>
        <IconButton label="Re-check design" shortcut="⇧C" onClick={onRecheck}>
          <RefreshCw />
        </IconButton>
        <IconButton label="Close design check" shortcut="Esc" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto p-3">
        <p className="font-medium">{summary(findings)}</p>
        <div role="status" aria-live="polite" className="sr-only">
          {`Design check ${String(state.runs)}: ${summary(findings)}.`}
        </div>

        {stale && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900">
            <span>The board changed since this check.</span>
            <Button size="sm" variant="outline" onClick={onRecheck}>
              Re-check
            </Button>
          </div>
        )}

        {result.ruleErrors.length > 0 && (
          <p className="text-muted-foreground">
            {`${String(result.ruleErrors.length)} check${result.ruleErrors.length === 1 ? "" : "s"} couldn't run on this board.`}
          </p>
        )}

        {findings.length > 0 && (
          <ul aria-label="Findings" className="flex flex-col gap-2">
            {findings.map((finding) => {
              const meta = SEVERITY_META[finding.severity];
              const Icon = meta.icon;
              const active = state.focus?.key === finding.id;
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      onFocus({
                        key: finding.id,
                        shapeIds: finding.shapeIds,
                        tone: finding.severity,
                      });
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1.5 rounded-md border p-2.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active && "border-foreground/40 bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium",
                        meta.badgeClass,
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                      {meta.label}
                    </span>
                    <span className="font-medium">{finding.title}</span>
                    <span className="text-muted-foreground">{finding.explanation}</span>
                    <span>
                      <span className="font-medium">Fix: </span>
                      {finding.suggestion}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {ignored.length > 0 && (
          <details className="rounded-md border px-2.5 py-2">
            <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {`${String(ignored.length)} shape${ignored.length === 1 ? "" : "s"} not checked`}
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {ignored.slice(0, MAX_IGNORED_LISTED).map((item) => {
                const shapeId = item.shapeId ?? "";
                const key = `ignored:${shapeId}`;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-pressed={state.focus?.key === key}
                      onClick={() => {
                        onFocus({ key, shapeIds: [shapeId], tone: "info" });
                      }}
                      className="flex w-full flex-col rounded-sm px-1 py-1 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span>{describe(item)}</span>
                      <span className="text-xs text-muted-foreground">
                        {IGNORED_REASON_TEXT[item.reason]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {ignored.length > MAX_IGNORED_LISTED && (
              <p className="mt-1 text-xs text-muted-foreground">
                {`and ${String(ignored.length - MAX_IGNORED_LISTED)} more`}
              </p>
            )}
          </details>
        )}

        <p className="text-xs text-muted-foreground">
          A quick rule-based check for common problems (no AI). It only understands typed shapes
          from the palette and the arrows between them.
        </p>
      </div>
    </aside>
  );
}
