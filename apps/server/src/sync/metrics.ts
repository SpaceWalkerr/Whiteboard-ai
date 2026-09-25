import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/** Prometheus metrics for the sync server, served at GET /metrics. */
export function createSyncMetrics(registry = new Registry()) {
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    roomsActive: new Gauge({
      name: "sync_rooms_active",
      help: "Rooms with an in-memory document",
      registers: [registry],
    }),
    connectionsActive: new Gauge({
      name: "sync_connections_active",
      help: "Open WebSocket connections",
      registers: [registry],
    }),
    messages: new Counter({
      name: "sync_messages_total",
      help: "Messages received from clients, by type",
      labelNames: ["type"] as const,
      registers: [registry],
    }),
    updateBytes: new Counter({
      name: "sync_update_bytes_total",
      help: "Bytes of document updates received from clients",
      registers: [registry],
    }),
    rejected: new Counter({
      name: "sync_connections_rejected_total",
      help: "WebSocket upgrades refused, by reason",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    pendingUpdates: new Gauge({
      name: "sync_pending_updates",
      help: "Updates received but not yet committed to the database",
      registers: [registry],
    }),
    flushSeconds: new Histogram({
      name: "sync_flush_seconds",
      help: "Time to commit one batch of updates",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    loadSeconds: new Histogram({
      name: "sync_room_load_seconds",
      help: "Time to load a board from the database",
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    persistFailures: new Counter({
      name: "sync_persist_failures_total",
      help: "Failed attempts to commit updates (retried)",
      registers: [registry],
    }),
    compactions: new Counter({
      name: "sync_compactions_total",
      help: "Snapshots written by compaction",
      registers: [registry],
    }),
    clusterMessages: new Counter({
      name: "sync_cluster_messages_total",
      help: "Messages exchanged with other instances over Redis, by kind and direction",
      labelNames: ["kind", "direction"] as const,
      registers: [registry],
    }),
    clusterDropped: new Counter({
      name: "sync_cluster_dropped_total",
      help: "Cluster messages dropped (malformed, publish failed, conflicting presence)",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    roomsWriter: new Gauge({
      name: "sync_rooms_writer",
      help: "Rooms this instance currently persists (holds the persistence lease for)",
      registers: [registry],
    }),
    leaseChanges: new Counter({
      name: "sync_lease_changes_total",
      help: "Persistence lease transitions, by change (acquired, lost, released, fail_open)",
      labelNames: ["change"] as const,
      registers: [registry],
    }),
    resyncs: new Counter({
      name: "sync_cluster_resyncs_total",
      help: "Resync rounds with other instances (periodic, and after a Redis reconnect)",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    closed: new Counter({
      name: "sync_connections_closed_total",
      help: "Connections closed, by close code",
      labelNames: ["code"] as const,
      registers: [registry],
    }),
  };
}

export type SyncMetrics = ReturnType<typeof createSyncMetrics>;
