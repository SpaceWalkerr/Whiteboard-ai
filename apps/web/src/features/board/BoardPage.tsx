import { ArrowLeft, Link2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Awareness } from "y-protocols/awareness";
import { BoardHistory, BoardStore, type SystemShapeType } from "@whiteboard/shared/board";
import type { PresenceUser } from "@whiteboard/shared/sync";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BoardCanvas } from "./canvas/BoardCanvas";
import { TextEditor } from "./canvas/TextEditor";
import { BoardController } from "./controller";
import { installDebugTools } from "./debug";
import { CanvasInteractions } from "./interaction/pointer";
import { isMac } from "./keyboard/shortcuts";
import { useBoardKeyboard } from "./keyboard/useBoardKeyboard";
import { useClipboard } from "./keyboard/useClipboard";
import { shapeText } from "./model/defaults";
import { loadGuest, saveGuest } from "./sync/guestIdentity";
import { PeersStore, StatusStore } from "./sync/stores";
import {
  useFollow,
  useLocalCache,
  usePresencePublisher,
  useSyncConnection,
} from "./sync/useBoardSync";
import { BoardContextMenu } from "./ui/BoardContextMenu";
import { ConnectionStatus, OfflineBanner } from "./ui/ConnectionStatus";
import { IconButton } from "./ui/IconButton";
import { PresenceAvatars } from "./ui/PresenceAvatars";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { QuickInsertDialog } from "./ui/QuickInsertDialog";
import { RemoteCursors } from "./ui/RemoteCursors";
import { ShapePalette } from "./ui/ShapePalette";
import { ShortcutsDialog } from "./ui/ShortcutsDialog";
import { Toolbar } from "./ui/Toolbar";
import { ZoomControls } from "./ui/ZoomControls";
import { ensureVisible, viewportCenterWorld } from "./viewport/zoomActions";
import { ViewportStore } from "./viewport/viewportStore";

interface BoardSession {
  controller: BoardController;
  viewport: ViewportStore;
  interactions: CanvasInteractions;
  awareness: Awareness;
  status: StatusStore;
  peers: PeersStore;
}

function createSession(userId: string): BoardSession {
  const store = new BoardStore({ userId });
  const history = new BoardHistory(store);
  const controller = new BoardController(store, history);
  const viewport = new ViewportStore();
  // Start with the world origin a little inside the top-left, clear of the palette.
  viewport.set({ x: 120, y: 80, scale: 1 });
  const interactions = new CanvasInteractions(controller, viewport);
  const awareness = new Awareness(store.doc);
  return {
    controller,
    viewport,
    interactions,
    awareness,
    status: new StatusStore(),
    peers: new PeersStore(awareness),
  };
}

interface BoardPageProps {
  boardId: string;
  /** Sync server base URL (VITE_WS_URL). */
  serverUrl: string;
  debugTools: boolean;
}

/**
 * /board/:boardId — a live, shared board. Everyone with the link edits the same document
 * through the sync server. Nothing is persisted yet (Phase 3): a room lives in server memory
 * while anyone is connected, plus a short grace period.
 *
 * The session (Y.Doc, store, history, controller) is a self-contained object graph with no
 * external listeners, so it is garbage-collected with the component and needs no teardown.
 * Destroying it in an effect cleanup would break React StrictMode's development remount,
 * which keeps state but runs cleanups. External side effects (the sync connection, the debug
 * hook) are set up and torn down in effects. The route keys this page by board id, so each
 * board gets a fresh session.
 */
export function BoardPage({ boardId, serverUrl, debugTools }: BoardPageProps) {
  const [me, setMe] = useState(loadGuest);
  const [session] = useState(() => createSession(me.id));
  useLocalCache(session.controller, boardId);
  useSyncConnection({
    serverUrl,
    boardId,
    controller: session.controller,
    awareness: session.awareness,
    status: session.status,
  });
  useEffect(
    () =>
      debugTools
        ? installDebugTools(session.controller, session.viewport, {
            status: () => session.status.get().connection,
            saveState: () => session.status.get().save,
            peers: () => session.peers.get().map((p) => p.presence),
            me: () => me,
          })
        : undefined,
    [session, debugTools, me],
  );
  const rename = useCallback((name: string) => {
    setMe((current) => {
      const next = { ...current, name };
      saveGuest(next);
      return next;
    });
  }, []);
  return <BoardView session={session} boardId={boardId} me={me} onRename={rename} />;
}

function BoardView({
  session,
  boardId,
  me,
  onRename,
}: {
  session: BoardSession;
  boardId: string;
  me: PresenceUser;
  onRename: (name: string) => void;
}) {
  const { controller, viewport, interactions, awareness } = session;
  const status = useSyncExternalStore(session.status.subscribe, session.status.get);
  const peers = useSyncExternalStore(session.peers.subscribe, session.peers.get);
  const [followingClientId, setFollowingClientId] = useState<number | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const publishCursor = usePresencePublisher({ me, controller, viewport, awareness });
  useFollow({
    followingClientId,
    setFollowing: setFollowingClientId,
    peers: session.peers,
    viewport,
  });
  const [mac] = useState(() => isMac(navigator.userAgent));
  const modKey = mac ? "⌘" : "Ctrl+";
  const [spacePressed, setSpacePressed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const pointerWorld = useRef<{ x: number; y: number } | null>(null);
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);

  const onSpaceChange = useCallback(
    (pressed: boolean) => {
      interactions.setSpacePressed(pressed);
      setSpacePressed(pressed);
    },
    [interactions],
  );
  const onPointerWorld = useCallback(
    (point: { x: number; y: number }) => {
      pointerWorld.current = point;
      publishCursor(point);
    },
    [publishCursor],
  );
  const onPointerLeave = useCallback(() => {
    publishCursor(null);
  }, [publishCursor]);
  const onEscape = useCallback(() => {
    if (followingClientId === null) return false;
    setFollowingClientId(null);
    return true;
  }, [followingClientId]);
  const openShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, []);
  const openInsert = useCallback(() => {
    setInsertOpen(true);
  }, []);
  const pasteTarget = useCallback(
    () => pointerWorld.current ?? viewportCenterWorld(viewport),
    [viewport],
  );

  useBoardKeyboard({
    controller,
    interactions,
    viewport,
    mac,
    onShowShortcuts: openShortcuts,
    onQuickInsert: openInsert,
    onSpaceChange,
    onEscape,
  });
  useClipboard(controller, pasteTarget);

  const singleSelected =
    ui.selectedIds.size === 1 ? controller.store.getShape([...ui.selectedIds][0] ?? "") : undefined;
  const connectFrom =
    singleSelected && singleSelected.type !== "arrow" ? singleSelected : undefined;

  const remoteSelections = peers.map((peer) => ({
    color: peer.presence.user.color,
    ids: peer.presence.selection,
  }));
  const followed = peers.find((peer) => peer.clientId === followingClientId);

  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      setTimeout(() => {
        setLinkCopied(false);
      }, 2000);
    });
  };

  const onInsert = (type: SystemShapeType, connect: boolean) => {
    setInsertOpen(false);
    const id = controller.insertSystemShape(
      type,
      viewportCenterWorld(viewport),
      connect && connectFrom ? connectFrom.id : null,
    );
    const inserted = controller.store.getShape(id);
    if (inserted)
      ensureVisible(viewport, {
        x: inserted.x,
        y: inserted.y,
        width: inserted.w,
        height: inserted.h,
      });
  };

  return (
    <TooltipProvider>
      <div className="fixed inset-0 overflow-hidden bg-white">
        <BoardContextMenu controller={controller} modKey={modKey} pasteTarget={pasteTarget}>
          <main
            className="absolute inset-0"
            data-board-canvas
            aria-label="Whiteboard canvas. Press question mark for keyboard shortcuts, slash to insert a shape."
            onPointerDown={() => {
              // Return keyboard focus to the page so shortcuts (and Space-to-pan) never
              // activate a toolbar button that still has focus.
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            }}
          >
            <BoardCanvas
              controller={controller}
              viewport={viewport}
              interactions={interactions}
              isMac={mac}
              onPointerWorld={onPointerWorld}
              onPointerLeave={onPointerLeave}
              spacePressed={spacePressed}
              remoteSelections={remoteSelections}
            >
              <RemoteCursors peers={peers} viewport={viewport} />
              <TextEditor controller={controller} viewport={viewport} />
            </BoardCanvas>
          </main>
        </BoardContextMenu>

        <header className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-lg border bg-background py-1 pr-3 pl-1 shadow-sm">
          <Link
            to="/"
            aria-label="Back to home"
            className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="text-sm font-semibold">
            Board <span className="font-normal text-muted-foreground">{boardId.slice(0, 8)}</span>
          </h1>
        </header>

        <div className="absolute top-3 right-3 z-20 flex items-center gap-3 rounded-lg border bg-background py-1 pr-1 pl-3 shadow-sm">
          <ConnectionStatus state={status} />
          <PresenceAvatars
            me={me}
            peers={peers}
            followingClientId={followingClientId}
            onFollow={setFollowingClientId}
            onRename={onRename}
          />
          <IconButton
            label={linkCopied ? "Link copied" : "Copy link to this board"}
            onClick={copyLink}
          >
            <Link2 />
          </IconButton>
        </div>

        <OfflineBanner state={status} />

        {followed && (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 z-10 border-4"
            style={{ borderColor: followed.presence.user.color }}
          >
            <span
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md px-2 py-1 text-xs font-medium text-white"
              style={{ background: followed.presence.user.color }}
            >
              Following {followed.presence.user.name} — press Esc or move to stop
            </span>
          </div>
        )}

        <Toolbar controller={controller} modKey={modKey} onShowShortcuts={openShortcuts} />
        <ShapePalette controller={controller} />
        <PropertiesPanel controller={controller} />
        <ZoomControls controller={controller} viewport={viewport} modKey={modKey} />

        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} mac={mac} />
        <QuickInsertDialog
          open={insertOpen}
          onOpenChange={setInsertOpen}
          connectFromLabel={connectFrom ? (shapeText(connectFrom) ?? "") : null}
          onInsert={onInsert}
        />
        <SelectionAnnouncer count={ui.selectedIds.size} />
      </div>
    </TooltipProvider>
  );
}

/** Screen-reader feedback for canvas selection, which is otherwise invisible to them. */
function SelectionAnnouncer({ count }: { count: number }) {
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {count === 0 ? "Nothing selected" : `${count} ${count === 1 ? "shape" : "shapes"} selected`}
    </div>
  );
}
