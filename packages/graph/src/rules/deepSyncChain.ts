import { longestPath, subGraph } from "../context";
import type { GraphNode } from "../types";
import { makeFinding, named, type Rule } from "../rule";

/**
 * Only calls between application components count: client → LB → gateway → service → DB is
 * the normal shape of a request and shouldn't be reported as "deep".
 */
const CHAIN_KINDS = new Set<GraphNode["kind"]>(["service", "worker", "external_api"]);

/**
 * Every synchronous hop multiplies failure probability and adds its latency (and its tail
 * latency) to the request. Past a few hops the request is slow and fragile.
 */
export const deepSyncChainRule: Rule = {
  id: "deep-sync-chain",
  description: "A chain of synchronous service-to-service calls deeper than the limit.",
  check: ({ graph, options }) => {
    const sync = subGraph(
      graph,
      (node) => CHAIN_KINDS.has(node.kind),
      (edge) => edge.edgeType === "sync",
    );
    const path = longestPath(sync);
    const hops = path.length - 1;
    if (hops <= options.maxSyncDepth) return [];

    const arrows: string[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const edge = sync.edges.find((e) => e.from === path[i] && e.to === path[i + 1]);
      if (edge) arrows.push(edge.arrowId);
    }
    const labels = path.map((id) => named(graph.node(id)?.label ?? id));
    return [
      makeFinding("deep-sync-chain", "warning", [...path, ...arrows], {
        title: `${String(hops)} synchronous calls in a row: ${labels.join(" → ")}`,
        explanation:
          `A request waits on ${String(hops)} services one after another (the limit is ` +
          `${String(options.maxSyncDepth)}). Their latencies add up, and if any one of them is ` +
          "slow or down the whole request fails — availability is the product of every hop's.",
        suggestion:
          "Make steps that don't need to finish before responding asynchronous (Queue + " +
          "Worker), call independent services in parallel, or merge services that are always " +
          "called together. Add timeouts and circuit breakers on the remaining hops.",
      }),
    ];
  },
};
