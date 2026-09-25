import { useId, useState } from "react";
import { Link } from "react-router";
import type { DeniedReason } from "@whiteboard/shared/sync";

/** Board title; editors can rename it inline (Enter saves, Escape cancels). */
export function BoardTitle({
  title,
  editable,
  onChange,
}: {
  title: string;
  editable: boolean;
  onChange: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [shown, setShown] = useState(title);
  const inputId = useId();

  if (!editable) return <h1 className="max-w-[16rem] truncate text-sm font-semibold">{shown}</h1>;
  if (!editing) {
    return (
      <h1 className="text-sm font-semibold">
        <button
          type="button"
          className="max-w-[16rem] truncate rounded px-1 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={`Board title: ${shown}. Rename`}
          onClick={() => {
            setDraft(shown);
            setEditing(true);
          }}
        >
          {shown}
        </button>
      </h1>
    );
  }
  const save = () => {
    const next = draft.trim().slice(0, 120);
    setEditing(false);
    if (next && next !== shown) {
      setShown(next);
      onChange(next).catch(() => {
        setShown(shown);
      });
    }
  };
  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        Board title
      </label>
      <input
        id={inputId}
        // Focusing the field the user just asked to edit.
        ref={(el) => el?.focus()}
        className="h-7 w-56 rounded border bg-background px-1.5 text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={draft}
        maxLength={120}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    </>
  );
}

const MESSAGES: Record<DeniedReason, { title: string; body: string }> = {
  forbidden: {
    title: "Your access was removed",
    body: "The owner changed who can open this board.",
  },
  unauthorized: { title: "Sign in to keep viewing", body: "This board is no longer public." },
  not_found: {
    title: "This board was deleted",
    body: "It may be restorable from the owner's trash for 30 days.",
  },
};

/** Shown when the server ends our session because access changed (live revocation). */
export function AccessLostOverlay({ reason }: { reason: DeniedReason | null }) {
  if (reason === null) return null;
  const message = MESSAGES[reason];
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="access-lost-title"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="max-w-sm rounded-lg border bg-background p-6 shadow-lg">
        <h2 id="access-lost-title" className="text-lg font-semibold">
          {message.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{message.body}</p>
        <Link to="/app" className="mt-4 inline-block text-sm font-medium underline">
          Back to your boards
        </Link>
      </div>
    </div>
  );
}
