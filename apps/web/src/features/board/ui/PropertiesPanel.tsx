import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ArrowDownToLine,
  ArrowUpToLine,
  Trash2,
} from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { EDGE_TYPES, type ShapeStyle } from "@whiteboard/shared/board";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { BoardController } from "../controller";
import { FILL_COLORS, STROKE_COLORS } from "../model/colors";
import { shapeTypeLabel } from "../model/systemShapes";
import { IconButton } from "./IconButton";

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32, 48];
const EDGE_LABELS: Record<(typeof EDGE_TYPES)[number], string> = {
  sync: "Sync call",
  async: "Async message",
  replication: "Replication",
};

/**
 * Properties of the selection. Style edits apply to every selected shape. `besidePanel` moves
 * it left of the findings panel so both can be open (e.g. to fix a finding).
 */
export function PropertiesPanel({
  controller,
  besidePanel = false,
}: {
  controller: BoardController;
  besidePanel?: boolean;
}) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const selected = snapshot.ordered.filter((s) => ui.selectedIds.has(s.id));
  const first = selected[0];
  if (!first) return null;

  const single = selected.length === 1 ? first : null;
  const style = first.style;
  const setStyle = (patch: Partial<ShapeStyle>) => {
    controller.updateSelectionStyle(patch);
  };
  const hasFill = selected.some(
    (s) => s.type !== "arrow" && s.type !== "freehand" && s.type !== "text",
  );
  const hasText = selected.some((s) => s.type !== "freehand");
  const boxes = selected.filter((s) => s.type !== "arrow");

  return (
    <aside
      aria-label="Shape properties"
      className={cn(
        "absolute top-16 z-20 flex max-h-[calc(100%-5rem)] w-64 flex-col gap-4 overflow-y-auto rounded-lg border bg-background p-3 text-sm shadow-sm",
        besidePanel ? "right-[21.5rem]" : "right-3",
      )}
    >
      <h2 className="font-semibold">
        {single ? shapeTypeLabel(single) : `${selected.length} shapes`}
      </h2>

      {single &&
        single.type !== "text" &&
        single.type !== "sticky" &&
        single.type !== "freehand" && (
          <LabelField
            key={single.id}
            value={single.label}
            onCommit={(label) => {
              controller.updateShape(single.id, { label });
            }}
          />
        )}

      {single?.type === "database" && (
        <>
          <SelectField
            label="Engine"
            value={single.engine}
            options={[
              { value: "sql", label: "SQL" },
              { value: "nosql", label: "NoSQL" },
            ]}
            onChange={(engine) => {
              controller.updateShape(single.id, { engine: engine as "sql" | "nosql" });
            }}
          />
          <SelectField
            label="Role"
            value={single.role}
            options={[
              { value: "primary", label: "Primary" },
              { value: "replica", label: "Replica" },
            ]}
            onChange={(role) => {
              controller.updateShape(single.id, { role: role as "primary" | "replica" });
            }}
          />
        </>
      )}
      {single?.type === "queue" && (
        <SelectField
          label="Mode"
          value={single.mode}
          options={[
            { value: "queue", label: "Queue" },
            { value: "stream", label: "Stream" },
          ]}
          onChange={(mode) => {
            controller.updateShape(single.id, { mode: mode as "queue" | "stream" });
          }}
        />
      )}
      {single?.type === "arrow" && (
        <SelectField
          label="Connection type"
          value={single.edgeType}
          options={EDGE_TYPES.map((value) => ({ value, label: EDGE_LABELS[value] }))}
          onChange={(edgeType) => {
            controller.updateShape(single.id, {
              edgeType: edgeType as (typeof EDGE_TYPES)[number],
            });
          }}
        />
      )}

      <Swatches
        label="Stroke"
        colors={STROKE_COLORS}
        value={style.stroke}
        onChange={(stroke) => {
          setStyle({ stroke });
        }}
      />
      {hasFill && (
        <Swatches
          label="Fill"
          colors={FILL_COLORS}
          value={style.fill}
          onChange={(fill) => {
            setStyle({ fill });
          }}
        />
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Stroke width</legend>
        <ToggleGroup
          type="single"
          aria-label="Stroke width"
          value={String(style.strokeWidth)}
          onValueChange={(v) => {
            if (v) setStyle({ strokeWidth: Number(v) });
          }}
        >
          {[1, 2, 4].map((w) => (
            <ToggleGroupItem key={w} value={String(w)} aria-label={`${w} pixel`} className="w-12">
              {w}px
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Stroke style</legend>
        <ToggleGroup
          type="single"
          aria-label="Stroke style"
          value={style.strokeStyle}
          onValueChange={(v) => {
            if (v === "solid" || v === "dashed" || v === "dotted") setStyle({ strokeStyle: v });
          }}
        >
          {(["solid", "dashed", "dotted"] as const).map((s) => (
            <ToggleGroupItem key={s} value={s} className="w-16 capitalize">
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </fieldset>

      {hasText && (
        <SelectField
          label="Font size"
          value={String(style.fontSize)}
          options={FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` }))}
          onChange={(v) => {
            setStyle({ fontSize: Number(v) });
          }}
        />
      )}

      <OpacityField
        value={style.opacity}
        onCommit={(opacity) => {
          setStyle({ opacity });
        }}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Arrange</span>
        <div className="flex flex-wrap gap-0.5">
          <IconButton
            label="Bring to front"
            onClick={() => {
              controller.reorderSelection("front");
            }}
          >
            <ArrowUpToLine />
          </IconButton>
          <IconButton
            label="Send to back"
            onClick={() => {
              controller.reorderSelection("back");
            }}
          >
            <ArrowDownToLine />
          </IconButton>
          {boxes.length >= 2 && (
            <>
              <IconButton
                label="Align left"
                onClick={() => {
                  controller.alignSelection("left");
                }}
              >
                <AlignStartVertical />
              </IconButton>
              <IconButton
                label="Align centre"
                onClick={() => {
                  controller.alignSelection("center");
                }}
              >
                <AlignCenterVertical />
              </IconButton>
              <IconButton
                label="Align right"
                onClick={() => {
                  controller.alignSelection("right");
                }}
              >
                <AlignEndVertical />
              </IconButton>
              <IconButton
                label="Align top"
                onClick={() => {
                  controller.alignSelection("top");
                }}
              >
                <AlignStartHorizontal />
              </IconButton>
              <IconButton
                label="Align middle"
                onClick={() => {
                  controller.alignSelection("middle");
                }}
              >
                <AlignCenterHorizontal />
              </IconButton>
              <IconButton
                label="Align bottom"
                onClick={() => {
                  controller.alignSelection("bottom");
                }}
              >
                <AlignEndHorizontal />
              </IconButton>
            </>
          )}
          {boxes.length >= 3 && (
            <>
              <IconButton
                label="Distribute horizontally"
                onClick={() => {
                  controller.distributeSelection("horizontal");
                }}
              >
                <AlignHorizontalSpaceBetween />
              </IconButton>
              <IconButton
                label="Distribute vertically"
                onClick={() => {
                  controller.distributeSelection("vertical");
                }}
              >
                <AlignVerticalSpaceBetween />
              </IconButton>
            </>
          )}
          <IconButton
            label="Delete"
            shortcut="Del"
            onClick={() => {
              controller.deleteSelection();
            }}
          >
            <Trash2 />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

function LabelField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Label
      </label>
      <Input
        id={id}
        value={draft}
        maxLength={500}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Swatches({
  label,
  colors,
  value,
  onChange,
}: {
  label: string;
  colors: readonly { name: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {colors.map((color) => (
          <button
            key={color.value}
            type="button"
            aria-label={`${label}: ${color.name}`}
            aria-pressed={value === color.value}
            onClick={() => {
              onChange(color.value);
            }}
            className={cn(
              "size-6 rounded-full border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              value === color.value && "ring-2 ring-primary ring-offset-2",
            )}
            style={
              color.value === "transparent"
                ? {
                    background:
                      "linear-gradient(135deg, #fff 45%, #dc2626 45%, #dc2626 55%, #fff 55%)",
                  }
                : { background: color.value }
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

function OpacityField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? Math.round(value * 100);
  const commit = () => {
    if (draft !== null) onCommit(draft / 100);
    setDraft(null);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Opacity {shown}%
      </label>
      <input
        id={id}
        type="range"
        min={10}
        max={100}
        step={5}
        value={shown}
        onChange={(e) => {
          setDraft(Number(e.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="accent-primary"
      />
    </div>
  );
}
