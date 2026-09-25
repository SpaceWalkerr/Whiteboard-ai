import { useCallback, useEffect, useMemo } from "react";
import type { Awareness } from "y-protocols/awareness";
import {
  SyncProvider,
  type Presence,
  type PresenceUser,
  type TicketResult,
} from "@whiteboard/shared/sync";
import type { BoardController } from "../controller";
import type { Point } from "../geometry/bounds";
import type { ViewportStore } from "../viewport/viewportStore";
import { attachLocalCache } from "./localCache";
import { browserNetworkSignal } from "./networkSignal";
import { throttle, type PeersStore, type StatusStore } from "./stores";

/** Keeps the board cached in IndexedDB (opens instantly and offline; offline edits survive). */
export function useLocalCache(controller: BoardController, boardId: string): void {
  useEffect(() => attachLocalCache(controller.store, boardId), [controller, boardId]);
}

/** Connects the board's Y.Doc to the sync server for as long as the component is mounted. */
export function useSyncConnection(options: {
  serverUrl: string;
  boardId: string;
  controller: BoardController;
  awareness: Awareness;
  status: StatusStore;
  getTicket: () => Promise<TicketResult>;
}): void {
  const { serverUrl, boardId, controller, awareness, status, getTicket } = options;
  useEffect(() => {
    const provider = new SyncProvider({
      serverUrl,
      boardId,
      doc: controller.store.doc,
      awareness,
      network: browserNetworkSignal(),
      getTicket,
      scheduleFlush: (flush) => requestAnimationFrame(flush),
    });
    const publish = () => {
      status.set({
        connection: provider.getStatus(),
        save: provider.getSaveState(),
        denied: provider.getDeniedReason(),
      });
    };
    publish();
    const unsubscribe = provider.subscribe(publish);
    return () => {
      unsubscribe();
      provider.destroy();
    };
  }, [serverUrl, boardId, controller, awareness, status, getTicket]);
}

/**
 * Publishes my presence: identity, selection, viewport (for followers) and cursor. Returns a
 * throttled cursor publisher for pointer moves (null = pointer left the canvas).
 */
export function usePresencePublisher(options: {
  me: PresenceUser;
  controller: BoardController;
  viewport: ViewportStore;
  awareness: Awareness;
}): (cursor: Point | null) => void {
  const { me, controller, viewport, awareness } = options;

  useEffect(() => {
    const current = awareness.getLocalState() as Partial<Presence> | null;
    const initial: Presence = {
      user: me,
      cursor: current?.cursor ?? null,
      selection: [...controller.getUi().selectedIds],
      viewport: null,
    };
    awareness.setLocalState(initial);

    let lastSelection = controller.getUi().selectedIds;
    const unsubscribeUi = controller.subscribeUi(() => {
      const { selectedIds } = controller.getUi();
      if (selectedIds === lastSelection) return;
      lastSelection = selectedIds;
      awareness.setLocalStateField("selection", [...selectedIds]);
    });
    const publishViewport = throttle(() => {
      const vp = viewport.get();
      const size = viewport.getSize();
      awareness.setLocalStateField("viewport", { ...vp, width: size.width, height: size.height });
    }, 100);
    publishViewport(undefined);
    const unsubscribeViewport = viewport.subscribe(() => {
      publishViewport(undefined);
    });
    return () => {
      unsubscribeUi();
      unsubscribeViewport();
    };
  }, [me, controller, viewport, awareness]);

  const publishCursor = useMemo(
    () =>
      throttle((cursor: Point | null) => {
        if (awareness.getLocalState() !== null) awareness.setLocalStateField("cursor", cursor);
      }, 50),
    [awareness],
  );
  return publishCursor;
}

/**
 * Follow mode: while following someone, my viewport shows what they see (same centre and
 * zoom). Any pan/zoom of my own, or them leaving, stops following.
 */
export function useFollow(options: {
  followingClientId: number | null;
  setFollowing: (clientId: number | null) => void;
  peers: PeersStore;
  viewport: ViewportStore;
}): void {
  const { followingClientId, setFollowing, peers, viewport } = options;

  const apply = useCallback(() => {
    if (followingClientId === null) return;
    const peer = peers.get().find((p) => p.clientId === followingClientId);
    if (!peer) {
      setFollowing(null);
      return;
    }
    const theirs = peer.presence.viewport;
    if (!theirs) return;
    const center = {
      x: (theirs.width / 2 - theirs.x) / theirs.scale,
      y: (theirs.height / 2 - theirs.y) / theirs.scale,
    };
    const size = viewport.getSize();
    viewport.set(
      {
        scale: theirs.scale,
        x: size.width / 2 - center.x * theirs.scale,
        y: size.height / 2 - center.y * theirs.scale,
      },
      "follow",
    );
  }, [followingClientId, peers, viewport, setFollowing]);

  useEffect(() => {
    if (followingClientId === null) return;
    apply();
    const unsubscribePeers = peers.subscribe(apply);
    let last = viewport.get();
    const unsubscribeViewport = viewport.subscribe(() => {
      const current = viewport.get();
      if (current === last) return; // e.g. a window resize
      last = current;
      if (viewport.getSource() === "user") setFollowing(null);
    });
    return () => {
      unsubscribePeers();
      unsubscribeViewport();
    };
  }, [followingClientId, apply, peers, viewport, setFollowing]);
}
