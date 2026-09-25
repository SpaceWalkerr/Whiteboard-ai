import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { IgnoredReason, Severity } from "@whiteboard/graph";

export interface SeverityMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  /** Highlight outline on the canvas (≥ 3:1 against white, WCAG non-text contrast). */
  canvasColor: string;
  /** Badge classes: text ≥ 4.5:1 on its background. Severity is never shown by colour alone. */
  badgeClass: string;
}

export const SEVERITY_META: Record<Severity, SeverityMeta> = {
  critical: {
    label: "Critical",
    plural: "critical",
    icon: OctagonAlert,
    canvasColor: "#dc2626",
    badgeClass: "bg-red-50 text-red-800 border-red-200",
  },
  warning: {
    label: "Warning",
    plural: "warnings",
    icon: TriangleAlert,
    canvasColor: "#d97706",
    badgeClass: "bg-amber-50 text-amber-900 border-amber-200",
  },
  info: {
    label: "Info",
    plural: "info",
    icon: Info,
    canvasColor: "#2563eb",
    badgeClass: "bg-blue-50 text-blue-800 border-blue-200",
  },
};

export const IGNORED_REASON_TEXT: Record<IgnoredReason, string> = {
  not_a_component: "Not a system component — use a shape from the palette to include it",
  arrow_to_non_component: "Arrow connects to a shape that isn't a system component",
  dangling_arrow: "Arrow isn't attached at both ends",
  duplicate_id: "Duplicate shape",
  invalid: "Shape data is invalid",
};
