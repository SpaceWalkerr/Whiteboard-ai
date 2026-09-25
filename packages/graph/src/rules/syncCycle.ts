import { stronglyConnectedComponents, subGraph } from "../context";
import { makeFinding, named, type Rule } from "../rule";

/**
 * Synchronous calls that loop back (A → B → A) tie the services' availability and latency
 * together: a slow request can hold threads on every service in the loop until they all run
 * out, and retries amplify around the cycle. A self-call counts too.
 */
export const syncCycleRule: Rule = {
  id: "sync-cycle",
  description: "A cycle of synchronous calls.",
  check: ({ graph }) => {
    const sync = subGraph(
      graph,
      () => true,
      (edge) => edge.edgeType === "sync",
    );
    return stronglyConnectedComponents(sync).flatMap((members) => {
      const inCycle = new Set(members);
      const arrows = sync.edges
        .filter((edge) => inCycle.has(edge.from) && inCycle.has(edge.to))
        .map((edge) => edge.arrowId);
      // A single node is a cycle only if it calls itself.
      if (arrows.length === 0) return [];
      const ordered = [...members].sort((a, b) => graph.position(a) - graph.position(b));
      const labels = ordered.map((id) => named(graph.node(id)?.label ?? id));
      const title =
        ordered.length === 1
          ? `${labels[0] ?? "A component"} calls itself synchronously`
          : `Synchronous call cycle: ${labels.join(" ↔ ")}`;
      return [
        makeFinding("sync-cycle", "critical", [...ordered, ...arrows], {
          title,
          explanation:
            "Components in a synchronous loop wait on each other: one slow request can hold " +
            "threads or connections all the way round until every service in the loop is " +
            "exhausted, and retries multiply around the cycle. Deploys and failures can no " +
            "longer be isolated.",
          suggestion:
            "Break the loop: make one call asynchronous (publish an event to a Queue), move the " +
            "shared logic into one service, or have the downstream service receive the data it " +
            "needs instead of calling back.",
        }),
      ];
    });
  },
};
