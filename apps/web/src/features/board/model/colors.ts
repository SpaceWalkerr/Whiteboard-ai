/**
 * Preset colours. Stroke colours are chosen to keep ≥ 4.5:1 contrast on white (WCAG AA) so
 * labels drawn in the stroke colour stay readable; fills are light tints.
 */
export const STROKE_COLORS = [
  { name: "Ink", value: "#1f2937" },
  { name: "Gray", value: "#4b5563" },
  { name: "Red", value: "#b91c1c" },
  { name: "Orange", value: "#c2410c" },
  { name: "Green", value: "#15803d" },
  { name: "Teal", value: "#0f766e" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Violet", value: "#6d28d9" },
  { name: "Pink", value: "#be185d" },
] as const;

export const FILL_COLORS = [
  { name: "None", value: "transparent" },
  { name: "White", value: "#ffffff" },
  { name: "Light gray", value: "#f3f4f6" },
  { name: "Light red", value: "#fee2e2" },
  { name: "Light orange", value: "#ffedd5" },
  { name: "Yellow", value: "#fef08a" },
  { name: "Light green", value: "#dcfce7" },
  { name: "Light teal", value: "#ccfbf1" },
  { name: "Light blue", value: "#dbeafe" },
  { name: "Light violet", value: "#ede9fe" },
] as const;

export const SELECTION_COLOR = "#2563eb";
export const GRID_COLOR = "#e5e7eb";
