import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUTS, type KeyInput } from "../keyboard/shortcuts";
import { searchSystemShapes } from "../model/systemShapes";

function key(k: string, extra: Partial<KeyInput> = {}): KeyInput {
  return {
    key: k,
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  };
}

describe("shortcuts", () => {
  it("never binds two actions to the same key combination", () => {
    const seen = new Map<string, string>();
    for (const shortcut of SHORTCUTS) {
      for (const m of shortcut.match) {
        const id =
          `${m.key ?? ""}|${m.code ?? ""}|${String(Boolean(m.mod))}|${String(Boolean(m.shift))}|${String(Boolean(m.alt))}`.toLowerCase();
        expect(seen.get(id), `${shortcut.description} clashes`).toBeUndefined();
        seen.set(id, shortcut.description);
      }
    }
  });

  it("uses Cmd on macOS and Ctrl elsewhere", () => {
    expect(matchShortcut(key("z", { metaKey: true }), true)).toBe("undo");
    expect(matchShortcut(key("z", { ctrlKey: true }), false)).toBe("undo");
    expect(matchShortcut(key("z", { ctrlKey: true }), true)).toBeNull();
  });

  it("distinguishes redo from undo by Shift", () => {
    expect(matchShortcut(key("Z", { metaKey: true, shiftKey: true }), true)).toBe("redo");
  });

  it("matches shifted characters regardless of Shift", () => {
    expect(matchShortcut(key("?", { shiftKey: true }), true)).toBe("showShortcuts");
  });

  it("matches layout-independent codes for Shift+1", () => {
    expect(matchShortcut(key("!", { code: "Digit1", shiftKey: true }), true)).toBe("zoomToFit");
  });

  it("does not treat plain letters with modifiers as tools", () => {
    expect(matchShortcut(key("r", { metaKey: true }), true)).toBeNull();
    expect(matchShortcut(key("r"), true)).toBe("tool.rectangle");
  });
});

describe("searchSystemShapes", () => {
  it("finds shapes by label prefix, word and keyword", () => {
    expect(searchSystemShapes("data")[0]).toBe("database");
    expect(searchSystemShapes("db")).toContain("database");
    expect(searchSystemShapes("balancer")).toEqual(["load_balancer"]);
    expect(searchSystemShapes("redis")).toEqual(["cache"]);
  });

  it("returns everything for an empty query", () => {
    expect(searchSystemShapes("")).toHaveLength(12);
  });
});
