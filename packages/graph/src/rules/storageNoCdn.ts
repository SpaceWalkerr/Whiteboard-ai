import { STATIC_CONTENT_WORDS } from "../keywords";
import type { GraphNode } from "../types";
import { makeFinding, named, type Rule } from "../rule";

function servesStaticContent(node: GraphNode): boolean {
  if (node.kind === "object_storage") return true;
  return node.kind === "service" && STATIC_CONTENT_WORDS.test(node.label);
}

/**
 * Static files and media served straight from storage (or an origin server) to users travel
 * the full distance on every request and put all the load on one origin. A CDN in front
 * caches them near users.
 *
 * Direct client → storage links are warnings. Storage reached only through other components
 * (e.g. a service that uploads files) is reported as info: it may never serve users.
 */
export const storageNoCdnRule: Rule = {
  id: "storage-no-cdn",
  description: "Static content or object storage served to clients without a CDN.",
  check: ({ graph }) => {
    const clients = graph.ofKind("client").map((node) => node.id);
    if (clients.length === 0) return [];
    const reachable = graph.reachable(clients, (edge) => edge.edgeType !== "replication");

    return graph.nodes.filter(servesStaticContent).flatMap((target) => {
      if (!reachable.has(target.id)) return [];
      const links = graph.touching(target.id);
      if (links.some((edge) => graph.other(edge, target.id)?.kind === "cdn")) return [];

      const direct = links.filter((edge) => graph.other(edge, target.id)?.kind === "client");
      const shapeIds = [
        target.id,
        ...direct.flatMap((edge) => [edge.from === target.id ? edge.to : edge.from, edge.arrowId]),
      ];
      return [
        makeFinding("storage-no-cdn", direct.length > 0 ? "warning" : "info", shapeIds, {
          title: `No CDN in front of ${named(target.label)}`,
          explanation:
            direct.length > 0
              ? `Clients fetch content straight from ${named(target.label)}. Every request ` +
                "crosses the whole network to one origin, so users far away wait longer and " +
                "traffic spikes (and egress costs) land directly on it."
              : `${named(target.label)} is reachable from clients but has no CDN. If it serves ` +
                "files or media to users, each request goes all the way to the origin.",
          suggestion:
            "Put a CDN in front of it (clients → CDN → storage) with cache headers, and give " +
            "clients CDN URLs (signed if the content is private).",
        }),
      ];
    });
  },
};
