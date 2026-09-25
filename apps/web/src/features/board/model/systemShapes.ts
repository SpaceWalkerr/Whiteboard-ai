import {
  Archive,
  Cog,
  Database,
  DoorOpen,
  Globe,
  ListOrdered,
  Monitor,
  Network,
  Plug,
  Search,
  Server,
  Waves,
  Zap,
  type IconNode,
} from "lucide";
import {
  isSystemShape,
  type Shape,
  type SystemShape,
  type SystemShapeType,
} from "@whiteboard/shared/board";

export interface SystemShapeMeta {
  label: string;
  /** Extra words matched by quick insert ("/"), e.g. "db" for Database. */
  keywords: readonly string[];
  icon: IconNode;
}

/** Display metadata for the typed system-design shapes (palette, canvas, export). */
export const SYSTEM_SHAPE_META: Record<SystemShapeType, SystemShapeMeta> = {
  client: { label: "Client", keywords: ["browser", "mobile", "user", "frontend"], icon: Monitor },
  cdn: { label: "CDN", keywords: ["edge", "cache", "static"], icon: Globe },
  load_balancer: {
    label: "Load balancer",
    keywords: ["lb", "alb", "nginx", "haproxy"],
    icon: Network,
  },
  api_gateway: {
    label: "API gateway",
    keywords: ["gateway", "gw", "ingress", "proxy"],
    icon: DoorOpen,
  },
  service: { label: "Service", keywords: ["api", "server", "backend", "app", "svc"], icon: Server },
  database: {
    label: "Database",
    keywords: ["db", "sql", "postgres", "mysql", "nosql", "mongo"],
    icon: Database,
  },
  cache: { label: "Cache", keywords: ["redis", "memcached"], icon: Zap },
  queue: {
    label: "Queue",
    keywords: ["mq", "kafka", "sqs", "rabbitmq", "stream", "pubsub"],
    icon: ListOrdered,
  },
  object_storage: {
    label: "Object storage",
    keywords: ["s3", "blob", "bucket", "files"],
    icon: Archive,
  },
  search_index: {
    label: "Search index",
    keywords: ["elasticsearch", "opensearch", "search"],
    icon: Search,
  },
  worker: { label: "Worker", keywords: ["job", "consumer", "cron", "background"], icon: Cog },
  external_api: {
    label: "External API",
    keywords: ["third party", "stripe", "webhook", "api"],
    icon: Plug,
  },
};

/** Icon for a specific shape (a queue in stream mode gets a different icon). */
export function systemShapeIcon(shape: SystemShape): IconNode {
  if (shape.type === "queue" && shape.mode === "stream") return Waves;
  return SYSTEM_SHAPE_META[shape.type].icon;
}

/**
 * Small secondary line under the label, e.g. "SQL · replica", or the component type once the
 * label is renamed ("Orders API" / "Service"). Empty when it would just repeat the label.
 */
export function systemShapeCaption(shape: SystemShape): string {
  switch (shape.type) {
    case "database":
      return `${shape.engine === "sql" ? "SQL" : "NoSQL"} · ${shape.role}`;
    case "queue":
      return shape.mode === "stream" ? "Stream" : "Queue";
    default: {
      const typeLabel = SYSTEM_SHAPE_META[shape.type].label;
      return shape.label.trim().toLowerCase() === typeLabel.toLowerCase() ? "" : typeLabel;
    }
  }
}

/** Case-insensitive search for quick insert: label prefix, word prefix, or keyword. */
export function searchSystemShapes(query: string): SystemShapeType[] {
  const q = query.trim().toLowerCase();
  const all = Object.keys(SYSTEM_SHAPE_META) as SystemShapeType[];
  if (q === "") return all;
  const scored = all
    .map((type) => {
      const meta = SYSTEM_SHAPE_META[type];
      const label = meta.label.toLowerCase();
      let score = 0;
      if (label.startsWith(q)) score = 3;
      else if (label.split(" ").some((word) => word.startsWith(q))) score = 2;
      else if (meta.keywords.some((k) => k.startsWith(q))) score = 1;
      return { type, score };
    })
    .filter((entry) => entry.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.type);
}

/** Human name of any shape's type ("Database", "Sticky note"). */
export function shapeTypeLabel(shape: Shape): string {
  if (isSystemShape(shape)) return SYSTEM_SHAPE_META[shape.type].label;
  return {
    rectangle: "Rectangle",
    ellipse: "Ellipse",
    text: "Text",
    sticky: "Sticky note",
    freehand: "Drawing",
    arrow: "Arrow",
  }[shape.type];
}
