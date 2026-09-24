import { describe, expect, it } from "vitest";
import { GRAPH_FORMAT_VERSION } from "../src";

describe("@whiteboard/graph", () => {
  it("exposes a positive integer graph format version", () => {
    expect(Number.isInteger(GRAPH_FORMAT_VERSION)).toBe(true);
    expect(GRAPH_FORMAT_VERSION).toBeGreaterThan(0);
  });
});
