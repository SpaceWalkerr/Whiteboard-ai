import type { IconNode } from "lucide";
import { createElement } from "react";

/** Renders a Lucide icon node list as inline SVG (same icons the canvas draws). */
export function NodeIcon({ icon, className }: { icon: IconNode; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {icon.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}
