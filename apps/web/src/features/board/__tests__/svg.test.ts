import { describe, expect, it } from "vitest";
import { boardToSvg, escapeXml } from "../export/svg";
import { wrapText } from "../export/wrapText";
import { createArrowShape } from "../model/defaults";
import { box, rect } from "./fixtures";

describe("boardToSvg", () => {
  it("returns null for an empty board", () => {
    expect(boardToSvg([])).toBeNull();
  });

  it("exports shapes, icons, labels and arrows within padded bounds", () => {
    const service = box("service", { x: 0, y: 0, width: 160, height: 96 }, "s", {
      label: "Orders <API>",
    });
    const db = box("database", { x: 400, y: 0, width: 160, height: 96 }, "d");
    const arrow = createArrowShape(
      { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, fromShapeId: "s", toShapeId: "d" },
      { id: "a", zIndex: "a2", userId: "t", now: 0 },
    );
    const result = boardToSvg([service, db, { ...arrow, label: "reads" }]);
    expect(result).not.toBeNull();
    const svg = result?.svg ?? "";
    expect(svg).toContain("<svg");
    expect(svg).toContain("Orders &lt;API&gt;");
    expect(svg).toContain("SQL · primary");
    expect(svg).toContain('<line x1="160" y1="48" x2="400" y2="48"');
    expect(svg).toContain(">reads<");
    expect(result?.bounds.x).toBeLessThan(0);
    expect(result?.bounds.width).toBeGreaterThan(560);
  });

  it("applies rotation as an SVG transform", () => {
    const svg = boardToSvg([rect("r", 10, 20, 100, 50, { rotation: 30 })])?.svg ?? "";
    expect(svg).toContain('transform="translate(10 20) rotate(30)"');
  });
});

describe("text helpers", () => {
  it("wraps text to a width and respects newlines", () => {
    const measure = (text: string) => text.length * 10;
    expect(wrapText("one two three\nfour", 80, 16, measure)).toEqual(["one two", "three", "four"]);
  });

  it("escapes XML special characters", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
  });
});
