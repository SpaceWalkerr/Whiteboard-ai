import { makeFinding, named, type Rule } from "../rule";

/**
 * A primary database with no replica is a single point of failure: when it goes down (or its
 * disk does), every write — and usually every read — fails, and there is nothing to fail over to.
 *
 * A replica counts when it is linked to the primary: a database with role "replica" joined by
 * any arrow, or any database joined by a replication arrow. An unlinked replica elsewhere on the
 * board doesn't, because nothing says which primary it copies.
 */
export const dbSpofRule: Rule = {
  id: "db-spof",
  description: "A primary database with no replica (single point of failure).",
  check: ({ graph }) =>
    graph.ofKind("database").flatMap((db) => {
      if (db.props.role !== "primary") return [];
      const replicated = graph.touching(db.id).some((edge) => {
        const other = graph.other(edge, db.id);
        if (other?.kind !== "database" || other.id === db.id) return false;
        return edge.edgeType === "replication" || other.props.role === "replica";
      });
      if (replicated) return [];
      return [
        makeFinding("db-spof", "critical", [db.id], {
          title: `Single point of failure: ${named(db.label)} has no replica`,
          explanation:
            `${named(db.label)} is the only copy of its data. If it crashes, is restarted for ` +
            "maintenance or loses its disk, everything that depends on it fails and data " +
            "written since the last backup can be lost.",
          suggestion:
            "Add a second Database shape with role “Replica” and connect it to this one with a " +
            "Replication arrow (a standby for failover, which can also serve reads).",
        }),
      ];
    }),
};
