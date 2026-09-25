import type { Shape } from "@whiteboard/shared/board";
import type { Severity } from "../../src";
import { board } from "./board";

/**
 * Fixture boards for every rule: at least one positive (the rule fires, with the exact shapes
 * it should highlight) and one negative (it stays quiet). Each case runs only its own rule.
 */
export interface RuleFixture {
  ruleId: string;
  name: string;
  shapes: Shape[];
  /** Expected findings from this rule; empty for negative fixtures. */
  expected: { severity: Severity; shapeIds: string[] }[];
}

/** A reasonable design that no rule should flag. */
export function healthyBoard(): Shape[] {
  return board()
    .add("client", "web", { label: "Web app" })
    .add("cdn", "cdn", { label: "CDN" })
    .add("object_storage", "assets", { label: "Assets bucket" })
    .add("load_balancer", "lb", { label: "LB" })
    .add("service", "api1", { label: "API 1" })
    .add("service", "api2", { label: "API 2" })
    .add("cache", "cache", { label: "Redis" })
    .add("database", "db", { label: "Postgres", role: "primary" })
    .add("database", "db-replica", { label: "Postgres replica", role: "replica" })
    .add("queue", "jobs", { label: "Jobs" })
    .add("queue", "jobs-dlq", { label: "Jobs DLQ" })
    .add("worker", "worker", { label: "Worker" })
    .arrow("web", "cdn", { label: "GET /static" })
    .arrow("cdn", "assets")
    .arrow("web", "lb", { label: "GET /feed" })
    .arrow("lb", "api1")
    .arrow("lb", "api2")
    .arrow("api1", "cache")
    .arrow("api2", "cache")
    .arrow("api1", "db")
    .arrow("api2", "db")
    .arrow("db", "db-replica", { type: "replication" })
    .arrow("api1", "jobs", { type: "async" })
    .arrow("jobs", "worker", { type: "async" })
    .arrow("jobs", "jobs-dlq", { type: "async" })
    .arrow("worker", "db")
    .build();
}

export const RULE_FIXTURES: RuleFixture[] = [
  // ── db-spof ────────────────────────────────────────────────────────────────────────────
  {
    ruleId: "db-spof",
    name: "a single primary database",
    shapes: board().add("service", "api").add("database", "db").arrow("api", "db").build(),
    expected: [{ severity: "critical", shapeIds: ["db"] }],
  },
  {
    ruleId: "db-spof",
    name: "a replica exists but isn't connected to the primary",
    shapes: board().add("database", "db").add("database", "replica", { role: "replica" }).build(),
    expected: [{ severity: "critical", shapeIds: ["db"] }],
  },
  {
    ruleId: "db-spof",
    name: "a replica connected with any arrow",
    shapes: board()
      .add("database", "db")
      .add("database", "replica", { role: "replica" })
      .arrow("db", "replica", { type: "async" })
      .build(),
    expected: [],
  },
  {
    ruleId: "db-spof",
    name: "two primaries joined by replication (multi-primary)",
    shapes: board()
      .add("database", "a")
      .add("database", "b")
      .arrow("a", "b", { type: "replication" })
      .build(),
    expected: [],
  },
  {
    ruleId: "db-spof",
    name: "each unreplicated primary is reported separately",
    shapes: board()
      .add("database", "users")
      .add("database", "orders")
      .add("database", "orders-replica", { role: "replica" })
      .arrow("orders", "orders-replica", { type: "replication" })
      .build(),
    expected: [{ severity: "critical", shapeIds: ["users"] }],
  },

  // ── client-direct-db ───────────────────────────────────────────────────────────────────
  {
    ruleId: "client-direct-db",
    name: "a client calling the database",
    shapes: board()
      .add("client", "app")
      .add("database", "db")
      .arrow("app", "db", { id: "a1" })
      .build(),
    expected: [{ severity: "critical", shapeIds: ["app", "db", "a1"] }],
  },
  {
    ruleId: "client-direct-db",
    name: "an arrow from the database to the client counts too, one finding per pair",
    shapes: board()
      .add("client", "app")
      .add("database", "db")
      .arrow("db", "app", { id: "a1", type: "async" })
      .arrow("app", "db", { id: "a2" })
      .build(),
    expected: [{ severity: "critical", shapeIds: ["app", "db", "a1", "a2"] }],
  },
  {
    ruleId: "client-direct-db",
    name: "a client going through a service",
    shapes: board()
      .add("client", "app")
      .add("service", "api")
      .add("database", "db")
      .chain("app", "api", "db")
      .build(),
    expected: [],
  },

  // ── sync-cycle ─────────────────────────────────────────────────────────────────────────
  {
    ruleId: "sync-cycle",
    name: "two services calling each other",
    shapes: board()
      .add("service", "a")
      .add("service", "b")
      .add("service", "c")
      .arrow("a", "b", { id: "ab" })
      .arrow("b", "a", { id: "ba" })
      .arrow("b", "c", { id: "bc" })
      .build(),
    expected: [{ severity: "critical", shapeIds: ["a", "b", "ab", "ba"] }],
  },
  {
    ruleId: "sync-cycle",
    name: "a service calling itself",
    shapes: board().add("service", "a").arrow("a", "a", { id: "loop" }).build(),
    expected: [{ severity: "critical", shapeIds: ["a", "loop"] }],
  },
  {
    ruleId: "sync-cycle",
    name: "a loop closed by an async message",
    shapes: board()
      .add("service", "a")
      .add("service", "b")
      .arrow("a", "b")
      .arrow("b", "a", { type: "async" })
      .build(),
    expected: [],
  },

  // ── no-load-balancer ───────────────────────────────────────────────────────────────────
  {
    ruleId: "no-load-balancer",
    name: "a client calling two numbered instances directly",
    shapes: board()
      .add("client", "app")
      .add("service", "api1", { label: "API 1" })
      .add("service", "api2", { label: "API 2" })
      .arrow("app", "api1", { id: "x1" })
      .arrow("app", "api2", { id: "x2" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["api1", "api2", "app", "x1", "x2"] }],
  },
  {
    ruleId: "no-load-balancer",
    name: "an explicit instance count with a direct caller",
    shapes: board()
      .add("service", "orders")
      .add("service", "api", { label: "API ×3" })
      .arrow("orders", "api", { id: "x1" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["api", "orders", "x1"] }],
  },
  {
    ruleId: "no-load-balancer",
    name: "instances behind a load balancer or API gateway",
    shapes: board()
      .add("load_balancer", "lb")
      .add("api_gateway", "gw")
      .add("service", "api1", { label: "API 1" })
      .add("service", "api2", { label: "API 2" })
      .add("service", "search", { label: "Search x2" })
      .arrow("lb", "api1")
      .arrow("lb", "api2")
      .arrow("gw", "search")
      .build(),
    expected: [],
  },
  {
    ruleId: "no-load-balancer",
    name: "a single instance called directly",
    shapes: board().add("client", "app").add("service", "api").arrow("app", "api").build(),
    expected: [],
  },

  // ── read-path-no-cache ─────────────────────────────────────────────────────────────────
  {
    ruleId: "read-path-no-cache",
    name: "a feed service reading the database with no cache",
    shapes: board()
      .add("client", "app")
      .add("service", "feed", { label: "Feed service" })
      .add("database", "db")
      .arrow("app", "feed", { id: "a1" })
      .arrow("feed", "db", { id: "a2" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["feed", "db", "a2"] }],
  },
  {
    ruleId: "read-path-no-cache",
    name: "a read signalled only by the incoming call's label",
    shapes: board()
      .add("service", "api")
      .add("database", "db")
      .add("client", "app")
      .arrow("app", "api", { label: "GET /products" })
      .arrow("api", "db", { id: "q" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["api", "db", "q"] }],
  },
  {
    ruleId: "read-path-no-cache",
    name: "a cache next to the service",
    shapes: board()
      .add("service", "feed", { label: "Feed service" })
      .add("database", "db")
      .add("cache", "cache")
      .arrow("feed", "db")
      .arrow("feed", "cache")
      .build(),
    expected: [],
  },
  {
    ruleId: "read-path-no-cache",
    name: "a write path with no read signal",
    shapes: board()
      .add("service", "payments", { label: "Payments" })
      .add("database", "db", { label: "Ledger" })
      .arrow("payments", "db", { label: "insert" })
      .build(),
    expected: [],
  },

  // ── deep-sync-chain ────────────────────────────────────────────────────────────────────
  {
    ruleId: "deep-sync-chain",
    name: "four synchronous service hops (limit 3)",
    shapes: board()
      .add("service", "s1")
      .add("service", "s2")
      .add("service", "s3")
      .add("service", "s4")
      .add("external_api", "s5")
      .arrow("s1", "s2", { id: "h1" })
      .arrow("s2", "s3", { id: "h2" })
      .arrow("s3", "s4", { id: "h3" })
      .arrow("s4", "s5", { id: "h4" })
      .build(),
    expected: [
      { severity: "warning", shapeIds: ["s1", "s2", "s3", "s4", "s5", "h1", "h2", "h3", "h4"] },
    ],
  },
  {
    ruleId: "deep-sync-chain",
    name: "three hops, plus infrastructure that doesn't count",
    shapes: board()
      .add("client", "app")
      .add("load_balancer", "lb")
      .add("api_gateway", "gw")
      .add("service", "s1")
      .add("service", "s2")
      .add("service", "s3")
      .add("service", "s4")
      .add("database", "db")
      .chain("app", "lb", "gw", "s1", "s2", "s3", "s4", "db")
      .build(),
    expected: [],
  },
  {
    ruleId: "deep-sync-chain",
    name: "an async hop breaks the chain",
    shapes: board()
      .add("service", "s1")
      .add("service", "s2")
      .add("service", "s3")
      .add("worker", "s4")
      .add("service", "s5")
      .arrow("s1", "s2")
      .arrow("s2", "s3")
      .arrow("s3", "s4", { type: "async" })
      .arrow("s4", "s5")
      .build(),
    expected: [],
  },

  // ── queue-no-dlq ───────────────────────────────────────────────────────────────────────
  {
    ruleId: "queue-no-dlq",
    name: "a queue with only a consumer",
    shapes: board()
      .add("service", "api")
      .add("queue", "q", { label: "Emails" })
      .add("worker", "w")
      .arrow("api", "q", { type: "async" })
      .arrow("q", "w", { type: "async" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["q"] }],
  },
  {
    ruleId: "queue-no-dlq",
    name: "a stream too",
    shapes: board().add("queue", "events", { label: "Events", mode: "stream" }).build(),
    expected: [{ severity: "warning", shapeIds: ["events"] }],
  },
  {
    ruleId: "queue-no-dlq",
    name: "a queue connected to a dead-letter queue",
    shapes: board()
      .add("queue", "q", { label: "Emails" })
      .add("queue", "dlq", { label: "emails-dead-letter" })
      .arrow("q", "dlq", { type: "async" })
      .build(),
    expected: [],
  },
  {
    ruleId: "queue-no-dlq",
    name: "a retry path on an edge label",
    shapes: board()
      .add("queue", "q", { label: "Emails" })
      .add("worker", "w")
      .arrow("q", "w", { type: "async" })
      .arrow("w", "q", { type: "async", label: "requeue with backoff" })
      .build(),
    expected: [],
  },

  // ── storage-no-cdn ─────────────────────────────────────────────────────────────────────
  {
    ruleId: "storage-no-cdn",
    name: "a client downloading straight from object storage",
    shapes: board()
      .add("client", "app")
      .add("object_storage", "s3")
      .arrow("app", "s3", { id: "get" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["s3", "app", "get"] }],
  },
  {
    ruleId: "storage-no-cdn",
    name: "a static-assets server called by clients",
    shapes: board()
      .add("client", "app")
      .add("service", "static", { label: "Static assets server" })
      .arrow("app", "static", { id: "get" })
      .build(),
    expected: [{ severity: "warning", shapeIds: ["static", "app", "get"] }],
  },
  {
    ruleId: "storage-no-cdn",
    name: "storage reached only through a service is info",
    shapes: board()
      .add("client", "app")
      .add("service", "api")
      .add("object_storage", "s3")
      .chain("app", "api", "s3")
      .build(),
    expected: [{ severity: "info", shapeIds: ["s3"] }],
  },
  {
    ruleId: "storage-no-cdn",
    name: "a CDN in front of storage",
    shapes: board()
      .add("client", "app")
      .add("cdn", "cdn")
      .add("object_storage", "s3")
      .chain("app", "cdn", "s3")
      .build(),
    expected: [],
  },
  {
    ruleId: "storage-no-cdn",
    name: "storage no client can reach",
    shapes: board()
      .add("client", "app")
      .add("service", "api")
      .add("worker", "w")
      .add("object_storage", "s3")
      .arrow("app", "api")
      .arrow("w", "s3")
      .build(),
    expected: [],
  },

  // ── disconnected ───────────────────────────────────────────────────────────────────────
  {
    ruleId: "disconnected",
    name: "an isolated component",
    shapes: board()
      .add("client", "app")
      .add("service", "api")
      .add("cache", "orphan")
      .arrow("app", "api")
      .build(),
    expected: [{ severity: "info", shapeIds: ["orphan"] }],
  },
  {
    ruleId: "disconnected",
    name: "a separate island; on a tie the island with the client is the main one",
    shapes: board()
      .add("service", "a")
      .add("database", "b")
      .add("client", "c")
      .add("service", "d")
      .arrow("a", "b", { id: "ab" })
      .arrow("c", "d", { id: "cd" })
      .build(),
    expected: [{ severity: "info", shapeIds: ["a", "b", "ab"] }],
  },
  {
    ruleId: "disconnected",
    name: "a fully connected design",
    shapes: board().add("client", "app").add("service", "api").arrow("app", "api").build(),
    expected: [],
  },
  {
    ruleId: "disconnected",
    name: "a board with a single component",
    shapes: board().add("service", "api").build(),
    expected: [],
  },
];
