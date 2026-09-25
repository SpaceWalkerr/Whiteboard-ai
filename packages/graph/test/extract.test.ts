import { describe, expect, it } from "vitest";
import { designGraphSchema, explicitInstanceCount, extractGraph, instanceLabelKey } from "../src";
import { board } from "./fixtures/board";

describe("extractGraph", () => {
  it("turns system shapes into typed nodes and arrows into edges", () => {
    const graph = extractGraph(
      board()
        .add("client", "web", { label: "  Web app " })
        .add("database", "db", { label: "Users", engine: "nosql", role: "replica" })
        .add("queue", "q", { label: "Events", mode: "stream" })
        .arrow("web", "db", { id: "a1", label: " GET /users ", type: "sync" })
        .arrow("db", "q", { id: "a2", type: "async" })
        .build(),
    );
    expect(designGraphSchema.parse(graph)).toEqual(graph);
    expect(graph.nodes).toEqual([
      {
        id: "web",
        kind: "client",
        label: "Web app",
        props: { unlabeled: false, instances: 1, groupId: null },
      },
      {
        id: "db",
        kind: "database",
        label: "Users",
        props: { unlabeled: false, instances: 1, groupId: null, engine: "nosql", role: "replica" },
      },
      {
        id: "q",
        kind: "queue",
        label: "Events",
        props: { unlabeled: false, instances: 1, groupId: null, mode: "stream" },
      },
    ]);
    expect(graph.edges).toEqual([
      { id: "a1", arrowId: "a1", from: "web", to: "db", edgeType: "sync", label: "GET /users" },
      { id: "a2", arrowId: "a2", from: "db", to: "q", edgeType: "async", label: "" },
    ]);
    expect(graph.ignored).toEqual([]);
  });

  it("gives unlabeled components their kind's name and marks them", () => {
    const graph = extractGraph(board().add("load_balancer", "lb", { label: "   " }).build());
    expect(graph.nodes[0]).toMatchObject({
      label: "Load balancer",
      props: { unlabeled: true, instances: 1 },
    });
  });

  it("ignores plain shapes, but reports them", () => {
    const graph = extractGraph(
      board().add("service", "api").rect("box", { label: "Postgres" }).sticky("note").build(),
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(["api"]);
    expect(graph.ignored).toEqual([
      { shapeId: "box", shapeType: "rectangle", reason: "not_a_component" },
      { shapeId: "note", shapeType: "sticky", reason: "not_a_component" },
    ]);
  });

  it("reports dangling arrows: a free end, both ends free, or bound to a missing shape", () => {
    const graph = extractGraph(
      board()
        .add("service", "api")
        .arrow("api", null, { id: "free-end" })
        .arrow(null, null, { id: "loose" })
        .arrow("api", "deleted", { id: "missing" })
        .build(),
    );
    expect(graph.edges).toEqual([]);
    expect(graph.ignored).toEqual([
      { shapeId: "free-end", shapeType: "arrow", reason: "dangling_arrow" },
      { shapeId: "loose", shapeType: "arrow", reason: "dangling_arrow" },
      { shapeId: "missing", shapeType: "arrow", reason: "dangling_arrow" },
    ]);
  });

  it("reports arrows to plain shapes outside any group", () => {
    const graph = extractGraph(
      board().add("service", "api").rect("box").arrow("api", "box", { id: "a" }).build(),
    );
    expect(graph.ignored).toContainEqual({
      shapeId: "a",
      shapeType: "arrow",
      reason: "arrow_to_non_component",
    });
  });

  it("resolves an arrow bound to a group's frame to the group's component", () => {
    const graph = extractGraph(
      board()
        .add("client", "app")
        .rect("frame", { groupId: "g" })
        .add("service", "api", { groupId: "g" })
        .arrow("app", "frame", { id: "a" })
        .build(),
    );
    expect(graph.edges).toEqual([
      { id: "a", arrowId: "a", from: "app", to: "api", edgeType: "sync", label: "" },
    ]);
    expect(graph.nodes.find((n) => n.id === "api")?.props.groupId).toBe("g");
  });

  it("fans an arrow to a group out to every component in it", () => {
    const graph = extractGraph(
      board()
        .add("load_balancer", "lb")
        .rect("frame", { groupId: "g" })
        .add("service", "s1", { groupId: "g" })
        .add("service", "s2", { groupId: "g" })
        .arrow("lb", "frame", { id: "a" })
        .build(),
    );
    expect(graph.edges.map((e) => [e.id, e.arrowId, e.from, e.to])).toEqual([
      ["a:lb->s1", "a", "lb", "s1"],
      ["a:lb->s2", "a", "lb", "s2"],
    ]);
  });

  it("drops self-pairs created only by resolving through a group", () => {
    const graph = extractGraph(
      board()
        .rect("frame", { groupId: "g" })
        .add("service", "s1", { groupId: "g" })
        .add("service", "s2", { groupId: "g" })
        .arrow("frame", "s1", { id: "a" })
        .build(),
    );
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([["s2", "s1"]]);
  });

  it("keeps a self-loop drawn on one component", () => {
    const graph = extractGraph(board().add("service", "a").arrow("a", "a", { id: "l" }).build());
    expect(graph.edges).toEqual([
      { id: "l", arrowId: "l", from: "a", to: "a", edgeType: "sync", label: "" },
    ]);
  });

  it("reports invalid records and duplicate ids instead of throwing", () => {
    const [api] = board().add("service", "api").build();
    const graph = extractGraph([
      api,
      { ...api, label: "copy" },
      { id: "broken", type: "service" },
      null,
      42,
      "text",
      { type: "database", id: 7 },
    ]);
    expect(graph.nodes.map((n) => n.label)).toEqual(["api"]);
    expect(graph.ignored).toEqual([
      { shapeId: "api", shapeType: "service", reason: "duplicate_id" },
      { shapeId: "broken", shapeType: "service", reason: "invalid" },
      { shapeId: null, shapeType: null, reason: "invalid" },
      { shapeId: null, shapeType: null, reason: "invalid" },
      { shapeId: null, shapeType: null, reason: "invalid" },
      { shapeId: null, shapeType: "database", reason: "invalid" },
    ]);
  });

  it("counts instances from numbered labels and explicit counts", () => {
    const graph = extractGraph(
      board()
        .add("service", "a1", { label: "Order service 1" })
        .add("service", "a2", { label: "Order Service #2" })
        .add("service", "a3", { label: "order service - 3" })
        .add("service", "b", { label: "API ×4" })
        .add("cache", "c1", { label: "Order service 1" })
        .add("service", "u1", { label: "" })
        .add("service", "u2", { label: "" })
        .build(),
    );
    const instances = Object.fromEntries(graph.nodes.map((n) => [n.id, n.props.instances]));
    // Same label, different kind (c1) is a different component; unlabeled shapes stay apart.
    expect(instances).toEqual({ a1: 3, a2: 3, a3: 3, b: 4, c1: 1, u1: 1, u2: 1 });
  });

  it("returns an empty graph for an empty board", () => {
    expect(extractGraph([])).toEqual({ nodes: [], edges: [], ignored: [] });
  });
});

describe("instance conventions", () => {
  it.each([
    ["API ×3", 3],
    ["API x3", 3],
    ["API (x2)", 2],
    ["3x API", 3],
    ["Workers * 5", 5],
    ["API (3 instances)", 3],
    ["2 replicas", 2],
    ["4 pods", 4],
    ["Box3", null],
    ["Mailbox", null],
    ["S3", null],
    ["API x0", null],
  ])("explicitInstanceCount(%j) = %j", (label, expected) => {
    expect(explicitInstanceCount(label)).toBe(expected);
  });

  it.each([
    ["Order service 1", "order service"],
    ["Order Service #2", "order service"],
    ["order-service-3", "order-service"],
    ["API instance 2", "api"],
    ["API ×3", "api"],
    ["S3", "s"],
    ["3", "3"],
    ["", ""],
  ])("instanceLabelKey(%j) = %j", (label, expected) => {
    expect(instanceLabelKey(label)).toBe(expected);
  });
});
