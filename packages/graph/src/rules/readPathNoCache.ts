import { READ_WORDS } from "../keywords";
import { makeFinding, named, type Rule } from "../rule";

/**
 * A read-heavy path that goes to the database on every request makes the database the
 * bottleneck and adds its latency to every page view. Only fires when labels say the path
 * serves reads (e.g. "GET /feed", "Timeline service"), so unlabeled boards aren't nagged.
 */
export const readPathNoCacheRule: Rule = {
  id: "read-path-no-cache",
  description: "A read-heavy path from a service to a database with no cache.",
  check: ({ graph }) =>
    graph.edges.flatMap((edge) => {
      if (edge.edgeType !== "sync") return [];
      const service = graph.node(edge.from);
      const db = graph.node(edge.to);
      if (!service || db?.kind !== "database") return [];
      if (service.kind !== "service" && service.kind !== "api_gateway") return [];

      const callsIn = graph.in(service.id).filter((e) => e.edgeType === "sync");
      const readHeavy = [edge.label, service.label, db.label, ...callsIn.map((e) => e.label)].some(
        (text) => READ_WORDS.test(text),
      );
      if (!readHeavy) return [];

      const hasCache = [service.id, db.id].some((id) =>
        graph.touching(id).some((e) => graph.other(e, id)?.kind === "cache"),
      );
      if (hasCache) return [];

      return [
        makeFinding("read-path-no-cache", "warning", [service.id, db.id, edge.arrowId], {
          title: `Read path ${named(service.label)} → ${named(db.label)} has no cache`,
          explanation:
            `Every read served by ${named(service.label)} goes to ${named(db.label)}. Read-heavy ` +
            "traffic then makes the database the bottleneck, and its latency is added to every " +
            "request.",
          suggestion:
            "Add a Cache (e.g. Redis) next to the service with a cache-aside read path and a TTL " +
            "or invalidation on writes; for hot, rarely changing data this removes most " +
            "database reads.",
        }),
      ];
    }),
};
