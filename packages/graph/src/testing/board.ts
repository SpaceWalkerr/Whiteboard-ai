import type { EdgeType, Shape, ShapeStyle, SystemShapeType } from "@whiteboard/shared/board";

/**
 * Tiny builder for fixture boards (tests and the AI review eval): valid `Shape` records, laid out left to right so board order
 * (and so finding order) follows the order of the calls.
 */

const style: ShapeStyle = {
  fill: "#ffffff",
  stroke: "#111827",
  strokeWidth: 2,
  strokeStyle: "solid",
  fontSize: 16,
  opacity: 1,
};

interface ComponentOptions {
  label?: string;
  groupId?: string | null;
  role?: "primary" | "replica";
  engine?: "sql" | "nosql";
  mode?: "queue" | "stream";
}

interface ArrowOptions {
  type?: EdgeType;
  label?: string;
  id?: string;
}

export class BoardBuilder {
  readonly shapes: Shape[] = [];
  private arrowCount = 0;

  private base(id: string) {
    const index = this.shapes.length;
    return {
      id,
      x: index * 200,
      y: 0,
      w: 140,
      h: 80,
      rotation: 0,
      zIndex: `a${String(index).padStart(4, "0")}`,
      style,
      groupId: null,
      createdBy: "test",
      updatedAt: 0,
    };
  }

  add(type: SystemShapeType, id: string, options: ComponentOptions = {}): this {
    const common = {
      ...this.base(id),
      groupId: options.groupId ?? null,
      label: options.label ?? id,
    };
    if (type === "database") {
      this.shapes.push({
        ...common,
        type,
        engine: options.engine ?? "sql",
        role: options.role ?? "primary",
      });
    } else if (type === "queue") {
      this.shapes.push({ ...common, type, mode: options.mode ?? "queue" });
    } else {
      this.shapes.push({ ...common, type });
    }
    return this;
  }

  rect(id: string, options: { label?: string; groupId?: string | null } = {}): this {
    this.shapes.push({
      ...this.base(id),
      type: "rectangle",
      label: options.label ?? "",
      groupId: options.groupId ?? null,
    });
    return this;
  }

  sticky(id: string, text = "note"): this {
    this.shapes.push({ ...this.base(id), type: "sticky", text });
    return this;
  }

  /** Arrow between two shape ids; `null` leaves that end free. */
  arrow(from: string | null, to: string | null, options: ArrowOptions = {}): this {
    this.arrowCount += 1;
    const id = options.id ?? `arrow-${String(this.arrowCount)}`;
    this.shapes.push({
      ...this.base(id),
      type: "arrow",
      fromShapeId: from,
      toShapeId: to,
      fromAnchor: "auto",
      toAnchor: "auto",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      label: options.label ?? "",
      edgeType: options.type ?? "sync",
    });
    return this;
  }

  /** Shorthand for a chain of sync arrows: chain("a", "b", "c") draws a → b → c. */
  chain(...ids: string[]): this {
    for (let i = 0; i < ids.length - 1; i++) this.arrow(ids[i] ?? null, ids[i + 1] ?? null);
    return this;
  }

  build(): Shape[] {
    return [...this.shapes];
  }
}

export function board(): BoardBuilder {
  return new BoardBuilder();
}
