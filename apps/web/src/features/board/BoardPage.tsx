import { ArrowLeft, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Awareness } from "y-protocols/awareness";
import { BoardHistory, BoardStore, type SystemShapeType } from "@whiteboard/shared/board";
import type { BoardDetail, BoardRole } from "@whiteboard/shared/api";
import type { DeniedReason, PresenceUser, TicketResult } from "@whiteboard/shared/sync";
import { useAuth } from "@/auth/authContext";
import { shareTokenFor } from "@/auth/localData";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessLostOverlay, BoardTitle } from "./ui/BoardHeader";
import { ShareDialog } from "./ui/ShareDialog";
import { BoardCanvas } from "./canvas/BoardCanvas";
import { TextEditor } from "./canvas/TextEditor";
import { BoardController } from "./controller";
import { installDebugTools } from "./debug";
import { CanvasInteractions } from "./interaction/pointer";
import { isMac } from "./keyboard/shortcuts";
import { useBoardKeyboard } from "./keyboard/useBoardKeyboard";
import { useClipboard } from "./keyboard/useClipboard";
import { shapeText } from "./model/defaults";
import { PeersStore, StatusStore } from "./sync/stores";
import { useThumbnail } from "./sync/useThumbnail";
import {
  useFollow,
  useLocalCache,
  usePresencePublisher,
  useSyncConnection,
} from "./sync/useBoardSync";
import { BoardContextMenu } from "./ui/BoardContextMenu";
import { ConnectionStatus, OfflineBanner } from "./ui/ConnectionStatus";
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
  role: RoleStore;
}

function createSession(userId: string, role: BoardRole): BoardSession {
  const store = new BoardStore({ userId });
  const history = new BoardHistory(store);
  const controller = new BoardController(store, history);
  controller.setReadOnly(role === "viewer");
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
    role: new RoleStore(role),
  };
}

/** The caller's current role; can change mid-session (e.g. downgraded to viewer). */
class RoleStore {
  private readonly listeners = new Set<() => void>();
  constructor(private role: BoardRole) {}
  get = (): BoardRole => this.role;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(role: BoardRole): void {
    if (role === this.role) return;
    this.role = role;
    for (const listener of this.listeners) listener();
  }
}

export type TicketFetchResult =
  { ok: true; ticket: string; role: BoardRole } | { ok: false; reason: DeniedReason | "error" };

interface BoardPageProps {
  boardId: string;
  /** Sync server base URL (VITE_WS_URL). */
  serverUrl: string;
  debugTools: boolean;
  detail: BoardDetail;
  me: PresenceUser;
  /** Asks the API for a room ticket (re-checks access); called before every (re)connect. */
  fetchTicket: () => Promise<TicketFetchResult>;
  onTitleChange: (title: string) => Promise<void>;
}

/**
 * /board/:boardId — a live, shared, persisted board. Access is enforced by the server: the
 * provider presents a short-lived room ticket on every (re)connect, and a viewer's writes are
 * dropped server-side (the UI is also view-only for them).
 *
 * The session (Y.Doc, store, history, controller) is a self-contained object graph with no
 * external listeners, so it is garbage-collected with the component and needs no teardown.
 * Destroying it in an effect cleanup would break React StrictMode's development remount,
 * which keeps state but runs cleanups. External side effects (the sync connection, the local
 * cache, the debug hook) are set up and torn down in effects. The route keys this page by board
 * id, so each board gets a fresh session.
 */
export function BoardPage({
  boardId,
  serverUrl,
  debugTools,
  detail,
  me,
  fetchTicket,
  onTitleChange,
}: BoardPageProps) {
  const [session] = useState(() => createSession(me.id, detail.role));
  const { api } = useAuth();
  const getTicket = useCallback(async (): Promise<TicketResult> => {
    const result = await fetchTicket();
    if (!result.ok) return result;
    // A new ticket may carry a different role (e.g. after being downgraded).
    session.controller.setReadOnly(result.role === "viewer");
    session.role.set(result.role);
    return { ok: true, ticket: result.ticket };
  }, [fetchTicket, session]);

  useLocalCache(session.controller, boardId);
  useThumbnail({
    store: session.controller.store,
    boardId,
    api,
    enabled: detail.role !== "viewer",
    shareToken: shareTokenFor(boardId),
  });
  useSyncConnection({
    serverUrl,
    boardId,
    controller: session.controller,
    awareness: session.awareness,
    status: session.status,
    getTicket,
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
  return (
    <BoardView
      session={session}
      boardId={boardId}
      me={me}
      title={detail.title}
      onTitleChange={onTitleChange}
    />
  );
}

function BoardView({
  session,
  boardId,
  me,
  title,
  onTitleChange,
}: {
  session: BoardSession;
  boardId: string;
  me: PresenceUser;
  title: string;
  onTitleChange: (title: string) => Promise<void>;
}) {
  const { controller, viewport, interactions, awareness } = session;
  const status = useSyncExternalStore(session.status.subscribe, session.status.get);
  const role = useSyncExternalStore(session.role.subscribe, session.role.get);
  const readOnly = role === "viewer";
  const [shareOpen, setShareOpen] = useState(false);
  const peers = useSyncExternalStore(session.peers.subscribe, session.peers.get);
  const [followingClientId, setFollowingClientId] = useState<number | null>(null);
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
    if (!controller.readOnly) setInsertOpen(true);
  }, [controller]);
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
            to="/app"
            aria-label="Back to your boards"
            className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <BoardTitle title={title} editable={!readOnly} onChange={onTitleChange} />
          {readOnly && (
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              View only
            </span>
          )}
        </header>

        <div className="absolute top-3 right-3 z-20 flex items-center gap-3 rounded-lg border bg-background py-1 pr-1 pl-3 shadow-sm">
          <ConnectionStatus state={status} />
          <PresenceAvatars
            me={me}
            peers={peers}
            followingClientId={followingClientId}
            onFollow={setFollowingClientId}
          />
          <Button
            size="sm"
            onClick={() => {
              setShareOpen(true);
            }}
          >
            <Users aria-hidden="true" />
            Share
          </Button>
        </div>

        <OfflineBanner state={status} />
        <AccessLostOverlay reason={status.connection === "denied" ? status.denied : null} />
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          boardId={boardId}
          canManage={role === "owner"}
        />

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

        <Toolbar
          controller={controller}
          modKey={modKey}
          onShowShortcuts={openShortcuts}
          readOnly={readOnly}
        />
        {!readOnly && <ShapePalette controller={controller} />}
        {!readOnly && <PropertiesPanel controller={controller} />}
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
