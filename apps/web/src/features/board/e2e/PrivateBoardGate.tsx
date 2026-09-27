import { Lock } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { BoardDetail } from "@whiteboard/shared/api";
import { FullPageMessage, LoadingPage } from "@/auth/RequireAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { forgetKey, keyFor, rememberKey } from "./keyring";
import { unlockBoard, type UnlockedBoard } from "./privateBoards";
import { keyFromHash, keyFromPasted } from "./roomKey";

type GateState =
  | { status: "checking" }
  | { status: "need_key"; wrongKey: boolean }
  | ({ status: "ready" } & UnlockedBoard);

/**
 * Opens a private board only with its key: from the link's fragment, or remembered on this
 * device. Without one (e.g. opened from an invite email, which never carries the key), asks
 * for the full link.
 */
export function PrivateBoardGate({
  detail,
  children,
}: {
  detail: BoardDetail;
  children: (board: UnlockedBoard) => ReactNode;
}) {
  const { hash } = useLocation();
  const [state, setState] = useState<GateState>({ status: "checking" });

  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      const fromLink = keyFromHash(hash);
      const candidate = fromLink ?? (await keyFor(detail.id));
      const unlocked = candidate ? await unlockBoard(detail, candidate) : null;
      if (run.cancelled) return;
      if (unlocked) {
        void rememberKey(detail.id, unlocked.roomKey.encoded);
        setState({ status: "ready", ...unlocked });
        return;
      }
      // A remembered key that no longer fits is useless; forget it.
      if (candidate && !fromLink) void forgetKey(detail.id);
      setState({ status: "need_key", wrongKey: fromLink !== null });
    })();
    return () => {
      run.cancelled = true;
    };
  }, [detail, hash]);

  if (state.status === "checking") return <LoadingPage label="Unlocking board…" />;
  if (state.status === "ready") return children({ roomKey: state.roomKey, title: state.title });
  return (
    <KeyPrompt
      detail={detail}
      wrongKey={state.wrongKey}
      onUnlocked={(board) => {
        void rememberKey(detail.id, board.roomKey.encoded);
        setState({ status: "ready", ...board });
      }}
    />
  );
}

function KeyPrompt({
  detail,
  wrongKey,
  onUnlocked,
}: {
  detail: BoardDetail;
  wrongKey: boolean;
  onUnlocked: (board: UnlockedBoard) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(
    wrongKey ? "The key in this link doesn't unlock this board." : null,
  );
  const [busy, setBusy] = useState(false);

  return (
    <FullPageMessage title="This board is end-to-end encrypted">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Its key is only in the link the owner shared — never on our servers. Paste the full link
        (the part after <code>#key=</code> is the key) to open it.
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const key = keyFromPasted(value, detail.id);
          if (!key) {
            setError("That isn't a link to this board with a key.");
            return;
          }
          setBusy(true);
          void unlockBoard(detail, key).then((board) => {
            setBusy(false);
            if (board) onUnlocked(board);
            else setError("That key doesn't unlock this board.");
          });
        }}
      >
        <label htmlFor={inputId} className="text-sm font-medium">
          Link with key
        </label>
        <Input
          id={inputId}
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || value.trim() === ""}>
            Open board
          </Button>
          <Button asChild variant="ghost">
            <Link to="/app">Go to your boards</Link>
          </Button>
        </div>
      </form>
    </FullPageMessage>
  );
}
