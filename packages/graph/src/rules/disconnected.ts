import { makeFinding, named, type Rule } from "../rule";

/**
 * Components not connected to the main design are usually an arrow someone forgot to draw (or
 * one that isn't attached). The main design is the largest island; on a tie, the one with a
 * client in it, then the one that comes first on the board.
 */
export const disconnectedRule: Rule = {
  id: "disconnected",
  description: "Components not connected to the rest of the design.",
  check: ({ graph }) => {
    const islands = graph.islands();
    if (islands.length < 2) return [];

    const hasClient = (island: readonly string[]) =>
      island.some((id) => graph.node(id)?.kind === "client");
    let main = islands[0] ?? [];
    for (const island of islands) {
      if (
        island.length > main.length ||
        (island.length === main.length && hasClient(island) && !hasClient(main))
      ) {
        main = island;
      }
    }

    return islands
      .filter((island) => island !== main)
      .map((island) => {
        const ordered = [...island].sort((a, b) => graph.position(a) - graph.position(b));
        const arrows = [
          ...new Set(ordered.flatMap((id) => graph.touching(id).map((edge) => edge.arrowId))),
        ];
        const labels = ordered.map((id) => named(graph.node(id)?.label ?? id));
        const single = ordered.length === 1;
        return makeFinding("disconnected", "info", [...ordered, ...arrows], {
          title: single
            ? `${labels[0] ?? "A component"} isn't connected to the rest of the design`
            : `${String(ordered.length)} components are disconnected from the rest of the design`,
          explanation: single
            ? `Nothing connects ${labels[0] ?? "this component"} to the main design, so it's ` +
              "unclear who calls it or what it depends on."
            : `${labels.join(", ")} form a separate group with no arrow to the main design.`,
          suggestion:
            "Connect it with an arrow bound to both shapes (drag the arrow's ends onto them), " +
            "or remove it if it's no longer part of the design.",
        });
      });
  },
};
