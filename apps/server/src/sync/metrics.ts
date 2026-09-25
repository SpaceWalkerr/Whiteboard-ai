import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";

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
    closed: new Counter({
      name: "sync_connections_closed_total",
      help: "Connections closed, by close code",
      labelNames: ["code"] as const,
      registers: [registry],
    }),
  };
}

export type SyncMetrics = ReturnType<typeof createSyncMetrics>;
