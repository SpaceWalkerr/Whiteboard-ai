import type { ComponentKind, DesignGraph, GraphEdge, GraphNode } from "./types";

/**
 * Indexes over a graph, built once per check and shared by every rule, plus the few graph
 * algorithms the rules need. All iterative (no recursion), so a large or adversarial board
 * can't overflow the stack.
 */
export class GraphIndex {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  private readonly byId = new Map<string, GraphNode>();
  private readonly order = new Map<string, number>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  constructor(graph: DesignGraph) {
    this.nodes = graph.nodes;
    this.edges = graph.edges;
    graph.nodes.forEach((node, index) => {
      this.byId.set(node.id, node);
      this.order.set(node.id, index);
      this.outgoing.set(node.id, []);
      this.incoming.set(node.id, []);
    });
    for (const edge of graph.edges) {
      // Edges always join extracted nodes; guard anyway so a hand-built graph can't crash rules.
      this.outgoing.get(edge.from)?.push(edge);
      this.incoming.get(edge.to)?.push(edge);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  /** Position of a node on the board (render order); used for deterministic output. */
  position(id: string): number {
    return this.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  out(id: string): readonly GraphEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  in(id: string): readonly GraphEdge[] {
    return this.incoming.get(id) ?? [];
  }

  /** Every edge touching the node, either direction (a self-loop appears once). */
  touching(id: string): GraphEdge[] {
    const result = [...this.out(id)];
    for (const edge of this.in(id)) if (edge.from !== edge.to) result.push(edge);
    return result;
  }

  /** The node at the other end of `edge` from `id`. */
  other(edge: GraphEdge, id: string): GraphNode | undefined {
    return this.node(edge.from === id ? edge.to : edge.from);
  }

  ofKind(...kinds: ComponentKind[]): GraphNode[] {
    return this.nodes.filter((node) => kinds.includes(node.kind));
  }

  /** Connected components ignoring direction and edge type, in board order of their first node. */
  islands(): string[][] {
    const seen = new Set<string>();
    const result: string[][] = [];
    for (const start of this.nodes) {
      if (seen.has(start.id)) continue;
      const island: string[] = [];
      const stack = [start.id];
      seen.add(start.id);
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined) break;
        island.push(id);
        for (const edge of this.touching(id)) {
          const next = edge.from === id ? edge.to : edge.from;
          if (!seen.has(next) && this.byId.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      result.push(island);
    }
    return result;
  }

  /** Nodes reachable from `starts` following edge direction through edges accepted by `use`. */
  reachable(starts: readonly string[], use: (edge: GraphEdge) => boolean): Set<string> {
    const seen = new Set<string>(starts);
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) break;
      for (const edge of this.out(id)) {
        if (!use(edge) || seen.has(edge.to)) continue;
        seen.add(edge.to);
        stack.push(edge.to);
      }
    }
    return seen;
  }
}

/** Adjacency restricted to some edges and nodes; the input to the algorithms below. */
export interface SubGraph {
  nodes: readonly string[];
  edges: readonly GraphEdge[];
}

export function subGraph(
  index: GraphIndex,
  keepNode: (node: GraphNode) => boolean,
  keepEdge: (edge: GraphEdge) => boolean,
): SubGraph {
  const nodes = index.nodes.filter(keepNode).map((node) => node.id);
  const kept = new Set(nodes);
  const edges = index.edges.filter(
    (edge) => keepEdge(edge) && kept.has(edge.from) && kept.has(edge.to),
  );
  return { nodes, edges };
}

function adjacency(graph: SubGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>(graph.nodes.map((id) => [id, []]));
  for (const edge of graph.edges) adj.get(edge.from)?.push(edge.to);
  return adj;
}

/**
 * Strongly connected components (Tarjan's algorithm, iterative). Returned in reverse
 * topological order of the condensation: every edge between components points from a later
 * component in the list to an earlier one.
 */
export function stronglyConnectedComponents(graph: SubGraph): string[][] {
  const adj = adjacency(graph);
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const root of graph.nodes) {
    if (indexOf.has(root)) continue;
    // Each frame is a node plus how many of its successors have been visited.
    const frames: { id: string; next: number }[] = [{ id: root, next: 0 }];
    indexOf.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      const successors = adj.get(frame.id) ?? [];
      if (frame.next < successors.length) {
        const next = successors[frame.next] ?? "";
        frame.next += 1;
        if (!indexOf.has(next)) {
          indexOf.set(next, counter);
          lowLink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id) ?? 0, indexOf.get(next) ?? 0));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id) ?? 0, lowLink.get(frame.id) ?? 0));
      }
      if (lowLink.get(frame.id) === indexOf.get(frame.id)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        result.push(component);
      }
    }
  }
  return result;
}

/**
 * The longest path (in edges) through the graph's condensation: nodes inside one cycle count
 * as one step, so the answer is well defined (and linear-time) even when there are cycles —
 * cycles are reported by their own rule. Returns the node ids along the path.
 */
export function longestPath(graph: SubGraph): string[] {
  const components = stronglyConnectedComponents(graph);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => {
    for (const id of members) componentOf.set(id, index);
  });

  // Edges between components, remembering one representative node pair per step.
  const outs = new Map<number, { to: number; from: string; toNode: string }[]>();
  for (const edge of graph.edges) {
    const a = componentOf.get(edge.from);
    const b = componentOf.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    const list = outs.get(a) ?? [];
    list.push({ to: b, from: edge.from, toNode: edge.to });
    outs.set(a, list);
  }

  // Tarjan's order is reverse topological, so successors are always computed first.
  const best = new Map<number, { length: number; path: string[] }>();
  components.forEach((members, index) => {
    let chosen = { length: 0, path: [members[0] ?? ""] };
    for (const step of outs.get(index) ?? []) {
      const tail = best.get(step.to);
      if (!tail) continue;
      // Without cycles each component is one node, so tail.path[0] is exactly step.toNode.
      // Inside a cycle the highlighted path may skip between its members; cycles are
      // reported by their own rule, and the hop count stays correct.
      const candidate = tail.length + 1;
      if (candidate > chosen.length) {
        chosen = { length: candidate, path: [step.from, step.toNode, ...tail.path.slice(1)] };
      }
    }
    best.set(index, chosen);
  });

  let longest: string[] = [];
  let longestLength = -1;
  for (const { length, path } of best.values()) {
    if (length > longestLength) {
      longest = path;
      longestLength = length;
    }
  }
  return longestLength <= 0 ? [] : longest;
}
