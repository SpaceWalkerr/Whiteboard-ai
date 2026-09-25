import type { GraphNode } from "../types";
import { instanceLabelKey } from "../instances";
import { makeFinding, named, type Rule } from "../rule";

const BALANCERS = new Set<GraphNode["kind"]>(["load_balancer", "api_gateway"]);

/**
 * A service running as several instances needs something spreading requests across them.
 * Callers wired straight to one instance send it all their traffic, and lose the service when
 * that instance dies, which defeats the point of having more than one.
 */
export const noLoadBalancerRule: Rule = {
  id: "no-load-balancer",
  description: "A service with more than one instance that is called without a load balancer.",
  check: ({ graph }) => {
    // Shapes of one scaled service (same label apart from a trailing number) are checked as one.
    const sets = new Map<string, GraphNode[]>();
    for (const node of graph.ofKind("service")) {
      if (node.props.instances < 2) continue;
      const key = node.props.unlabeled ? `#${node.id}` : instanceLabelKey(node.label);
      const members = sets.get(key) ?? [];
      members.push(node);
      sets.set(key, members);
    }

    return [...sets.values()].flatMap((members) => {
      const memberIds = new Set(members.map((node) => node.id));
      const bypassing = members.flatMap((member) =>
        graph.in(member.id).filter((edge) => {
          if (edge.edgeType !== "sync" || memberIds.has(edge.from)) return false;
          const caller = graph.node(edge.from);
          return caller !== undefined && !BALANCERS.has(caller.kind);
        }),
      );
      if (bypassing.length === 0) return [];
      const first = members[0];
      if (!first) return [];
      const instances = Math.max(...members.map((node) => node.props.instances));
      const callers = [...new Set(bypassing.map((edge) => edge.from))];
      const callerLabels = callers.map((id) => named(graph.node(id)?.label ?? id)).join(", ");
      return [
        makeFinding(
          "no-load-balancer",
          "warning",
          [...members.map((node) => node.id), ...callers, ...bypassing.map((e) => e.arrowId)],
          {
            title: `${named(first.label)} has ${String(instances)} instances but no load balancer in front`,
            explanation:
              `${callerLabels} ${callers.length === 1 ? "calls" : "call"} the instances of ` +
              `${named(first.label)} directly. Each caller then sends all its traffic to the ` +
              "instance it knows about, and fails when that instance is down or being deployed.",
            suggestion:
              "Put a Load Balancer (or API Gateway) between the callers and the instances, with " +
              "health checks. For internal calls, client-side load balancing via service " +
              "discovery also works — show it on the diagram.",
          },
        ),
      ];
    });
  },
};
