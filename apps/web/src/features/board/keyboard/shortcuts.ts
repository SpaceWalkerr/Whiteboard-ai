export type ShortcutAction =
  | "tool.select"
  | "tool.rectangle"
  | "tool.ellipse"
  | "tool.text"
  | "tool.sticky"
  | "tool.freehand"
  | "tool.arrow"
  | "quickInsert"
  | "undo"
  | "redo"
  | "duplicate"
  | "delete"
  | "selectAll"
  | "escape"
  | "selectNext"
  | "selectPrevious"
  | "group"
  | "ungroup"
  | "bringForward"
  | "sendBackward"
  | "bringToFront"
  | "sendToBack"
  | "zoomToFit"
  | "zoomReset"
  | "zoomIn"
  | "zoomOut"
  | "showShortcuts";

interface KeyMatch {
  /** Compared case-insensitively with KeyboardEvent.key. */
  key?: string;
  /** Compared with KeyboardEvent.code (layout-independent, used for shifted digits). */
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Shortcut {
  action: ShortcutAction | null;
  group: "Tools" | "Edit" | "Arrange" | "View";
  description: string;
  /** Human-readable keys; "Mod" renders as ⌘ on macOS and Ctrl elsewhere. */
  keys: readonly string[];
  match: readonly KeyMatch[];
}

/** Single source of truth for key handling AND the "?" cheat sheet. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    action: "tool.select",
    group: "Tools",
    description: "Select",
    keys: ["V"],
    match: [{ key: "v" }],
  },
  {
    action: "tool.rectangle",
    group: "Tools",
    description: "Rectangle",
    keys: ["R"],
    match: [{ key: "r" }],
  },
  {
    action: "tool.ellipse",
    group: "Tools",
    description: "Ellipse",
    keys: ["O"],
    match: [{ key: "o" }],
  },
  { action: "tool.text", group: "Tools", description: "Text", keys: ["T"], match: [{ key: "t" }] },
  {
    action: "tool.sticky",
    group: "Tools",
    description: "Sticky note",
    keys: ["N"],
    match: [{ key: "n" }],
  },
  {
    action: "tool.freehand",
    group: "Tools",
    description: "Pen (freehand)",
    keys: ["P"],
    match: [{ key: "p" }],
  },
  {
    action: "tool.arrow",
    group: "Tools",
    description: "Arrow (drag between shapes)",
    keys: ["A"],
    match: [{ key: "a" }],
  },
  {
    action: "quickInsert",
    group: "Tools",
    description: "Insert a system shape by name (connects from the selected shape)",
    keys: ["/"],
    match: [{ key: "/" }],
  },
  {
    action: "undo",
    group: "Edit",
    description: "Undo",
    keys: ["Mod", "Z"],
    match: [{ key: "z", mod: true }],
  },
  {
    action: "redo",
    group: "Edit",
    description: "Redo",
    keys: ["Mod", "Shift", "Z"],
    match: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
  },
  { action: null, group: "Edit", description: "Copy", keys: ["Mod", "C"], match: [] },
  { action: null, group: "Edit", description: "Cut", keys: ["Mod", "X"], match: [] },
  { action: null, group: "Edit", description: "Paste", keys: ["Mod", "V"], match: [] },
  {
    action: "duplicate",
    group: "Edit",
    description: "Duplicate",
    keys: ["Mod", "D"],
    match: [{ key: "d", mod: true }],
  },
  {
    action: "delete",
    group: "Edit",
    description: "Delete",
    keys: ["Delete"],
    match: [{ key: "Delete" }, { key: "Backspace" }],
  },
  {
    action: "selectAll",
    group: "Edit",
    description: "Select all",
    keys: ["Mod", "A"],
    match: [{ key: "a", mod: true }],
  },
  {
    action: "escape",
    group: "Edit",
    description: "Deselect / back to Select tool",
    keys: ["Esc"],
    match: [{ key: "Escape" }],
  },
  {
    action: "selectNext",
    group: "Edit",
    description: "Select next shape",
    keys: ["Tab"],
    match: [{ key: "Tab" }],
  },
  {
    action: "selectPrevious",
    group: "Edit",
    description: "Select previous shape",
    keys: ["Shift", "Tab"],
    match: [{ key: "Tab", shift: true }],
  },
  {
    action: null,
    group: "Edit",
    description: "Nudge (Shift: 10px)",
    keys: ["←", "↑", "→", "↓"],
    match: [],
  },
  { action: null, group: "Edit", description: "Edit text or label", keys: ["Enter"], match: [] },
  {
    action: "group",
    group: "Arrange",
    description: "Group",
    keys: ["Mod", "G"],
    match: [{ key: "g", mod: true }],
  },
  {
    action: "ungroup",
    group: "Arrange",
    description: "Ungroup",
    keys: ["Mod", "Shift", "G"],
    match: [{ key: "g", mod: true, shift: true }],
  },
  {
    action: "bringForward",
    group: "Arrange",
    description: "Bring forward",
    keys: ["]"],
    match: [{ key: "]" }],
  },
  {
    action: "sendBackward",
    group: "Arrange",
    description: "Send backward",
    keys: ["["],
    match: [{ key: "[" }],
  },
  {
    action: "bringToFront",
    group: "Arrange",
    description: "Bring to front",
    keys: ["Mod", "]"],
    match: [{ key: "]", mod: true }],
  },
  {
    action: "sendToBack",
    group: "Arrange",
    description: "Send to back",
    keys: ["Mod", "["],
    match: [{ key: "[", mod: true }],
  },
  {
    action: "zoomToFit",
    group: "View",
    description: "Zoom to fit",
    keys: ["Shift", "1"],
    match: [{ code: "Digit1", shift: true }],
  },
  {
    action: "zoomReset",
    group: "View",
    description: "Zoom to 100%",
    keys: ["Shift", "0"],
    match: [{ code: "Digit0", shift: true }],
  },
  {
    action: "zoomIn",
    group: "View",
    description: "Zoom in",
    keys: ["Mod", "+"],
    match: [
      { key: "=", mod: true },
      { key: "+", mod: true },
    ],
  },
  {
    action: "zoomOut",
    group: "View",
    description: "Zoom out",
    keys: ["Mod", "-"],
    match: [{ key: "-", mod: true }],
  },
  { action: null, group: "View", description: "Pan", keys: ["Space", "drag"], match: [] },
  { action: null, group: "View", description: "Zoom", keys: ["Mod", "scroll"], match: [] },
  {
    action: "showShortcuts",
    group: "View",
    description: "Keyboard shortcuts",
    keys: ["?"],
    match: [{ key: "?" }],
  },
];

export interface KeyInput {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** Keys whose character already implies Shift, so Shift is not compared for them. */
const SHIFTED_KEYS = new Set(["?", "+"]);

export function matchShortcut(event: KeyInput, mac: boolean): ShortcutAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  for (const shortcut of SHORTCUTS) {
    if (shortcut.action === null) continue;
    for (const m of shortcut.match) {
      if (m.key !== undefined && m.key.toLowerCase() !== event.key.toLowerCase()) continue;
      if (m.code !== undefined && m.code !== event.code) continue;
      if (Boolean(m.mod) !== mod) continue;
      if (Boolean(m.alt) !== event.altKey) continue;
      const shiftIrrelevant = m.key !== undefined && SHIFTED_KEYS.has(m.key);
      if (!shiftIrrelevant && Boolean(m.shift) !== event.shiftKey) continue;
      return shortcut.action;
    }
  }
  return null;
}

export function formatKey(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "⌘" : "Ctrl";
  if (key === "Shift") return mac ? "⇧" : "Shift";
  return key;
}
