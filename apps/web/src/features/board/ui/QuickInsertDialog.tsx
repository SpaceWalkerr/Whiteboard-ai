import { useId, useState } from "react";
import type { SystemShapeType } from "@whiteboard/shared/board";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SYSTEM_SHAPE_META, searchSystemShapes } from "../model/systemShapes";
import { NodeIcon } from "./NodeIcon";

interface QuickInsertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Label of the single selected shape the new one would connect from, if any. */
  connectFromLabel: string | null;
  onInsert: (type: SystemShapeType, connect: boolean) => void;
}

/** "/" palette: type a name, Enter inserts it (connected from the selected shape by default). */
export function QuickInsertDialog({
  open,
  onOpenChange,
  connectFromLabel,
  onInsert,
}: QuickInsertDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        {open && <QuickInsertBody connectFromLabel={connectFromLabel} onInsert={onInsert} />}
      </DialogContent>
    </Dialog>
  );
}

function QuickInsertBody({
  connectFromLabel,
  onInsert,
}: Omit<QuickInsertDialogProps, "open" | "onOpenChange">) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [connect, setConnect] = useState(true);
  const listId = useId();
  const connectId = useId();
  const results = searchSystemShapes(query);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const insert = (type: SystemShapeType | undefined) => {
    if (type) onInsert(type, connect && connectFromLabel !== null);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Insert shape</DialogTitle>
        <DialogDescription>
          Type to search, ↑↓ to choose, Enter to insert
          {connectFromLabel !== null ? ", connected from the selected shape." : "."}
        </DialogDescription>
      </DialogHeader>
      <Input
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={
          results[activeIndex] ? `${listId}-${results[activeIndex]}` : undefined
        }
        aria-label="Shape name"
        placeholder="e.g. db, cache, lb"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            insert(results[activeIndex]);
          }
        }}
      />
      {results.length === 0 && (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching shapes</p>
      )}
      {/* Keyboard users drive this list from the combobox input (aria-activedescendant). */}
      <div
        id={listId}
        role="listbox"
        aria-label="Matching shapes"
        className="max-h-64 overflow-y-auto"
      >
        {results.map((type, index) => (
          <div
            key={type}
            id={`${listId}-${type}`}
            role="option"
            aria-selected={index === activeIndex}
            onPointerMove={() => {
              setActive(index);
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              insert(type);
            }}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              index === activeIndex && "bg-accent text-accent-foreground",
            )}
          >
            <NodeIcon icon={SYSTEM_SHAPE_META[type].icon} className="size-4" />
            {SYSTEM_SHAPE_META[type].label}
          </div>
        ))}
      </div>
      {connectFromLabel !== null && (
        <div className="flex items-center gap-2 text-sm">
          <input
            id={connectId}
            type="checkbox"
            checked={connect}
            onChange={(e) => {
              setConnect(e.target.checked);
            }}
            className="size-4 accent-primary"
          />
          <label htmlFor={connectId}>Connect from “{connectFromLabel || "selected shape"}”</label>
        </div>
      )}
    </>
  );
}
