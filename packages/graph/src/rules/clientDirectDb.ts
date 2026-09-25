import { makeFinding, named, type Rule } from "../rule";

/**
 * Clients (browsers, mobile apps) must never talk to the database directly: its credentials
 * would ship to every user, authorization can't be enforced per request, and the schema becomes
 * a public API that can never change.
 */
export const clientDirectDbRule: Rule = {
  id: "client-direct-db",
  description: "A client connected directly to a database.",
  check: ({ graph }) => {
    // One finding per client–database pair, however many arrows join them.
    const pairs = new Map<string, { client: string; db: string; arrows: string[] }>();
    for (const edge of graph.edges) {
      const from = graph.node(edge.from);
      const to = graph.node(edge.to);
      if (!from || !to) continue;
      const client = from.kind === "client" ? from : to.kind === "client" ? to : undefined;
      const db = from.kind === "database" ? from : to.kind === "database" ? to : undefined;
      if (!client || !db) continue;
      const key = `${client.id}\u0000${db.id}`;
      const pair = pairs.get(key) ?? { client: client.id, db: db.id, arrows: [] };
      pair.arrows.push(edge.arrowId);
      pairs.set(key, pair);
    }
    return [...pairs.values()].map(({ client, db, arrows }) => {
      const clientLabel = graph.node(client)?.label ?? "Client";
      const dbLabel = graph.node(db)?.label ?? "Database";
      return makeFinding("client-direct-db", "critical", [client, db, ...arrows], {
        title: `${named(clientLabel)} talks directly to ${named(dbLabel)}`,
        explanation:
          "A client connected straight to the database needs database credentials on every " +
          "user's device, can't be authorized per request, and exposes the schema as a public " +
          "API that can never change safely.",
        suggestion:
          "Put a Service (behind a load balancer or API gateway) between the client and the " +
          "database, and let only that service hold the database credentials.",
      });
    });
  },
};
